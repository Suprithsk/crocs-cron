const axios = require("axios");
const cron = require("node-cron");
require("dotenv").config();

// The POST body the site sends to the Rome API. One product URL's response
// contains ALL colour/storage variants, so a single fetch covers every colour.
// FK_PAGE_URI overrides just the pageUri (everything after flipkart.com in the
// product URL, copied from the address bar); the rest mirrors a real browser
// request so Flipkart is less likely to reject it.
const REQUEST_BODY = {
  pageUri:
    process.env.FK_PAGE_URI ||
    "/apple-iphone-17-lavender-256-gb/p/itmf37c8dffa4165?pid=MOBHFN6YKGBPYJZD&marketplace=FLIPKART&lid=LSTMOBHFN6YKGBPYJZDEZPBYP&q=iphone+17&fm=search-autosuggest",
  pageContext: {
    trackingContext: { context: { eVar61: "direct_product" } },
    networkSpeed: 6500,
  },
};

// Ignore price wobbles at or below this many rupees to avoid noise.
const PRICE_THRESHOLD = Number(process.env.FK_PRICE_THRESHOLD || 100);

// Product URL for the "Buy Now" link in the alert email.
const PRODUCT_URL = `https://www.flipkart.com${REQUEST_BODY.pageUri}`;

// Variants to watch. A variant matches if its title contains ALL the terms in
// one of these groups (case-insensitive). Default watches every colour at
// 256 GB, e.g. "Apple iPhone 17 (Black, 256 GB)". Override with FK_WATCH, a
// JSON array of term-groups, e.g. [["Black","256 GB"],["White","512 GB"]].
const WATCHED = (
  process.env.FK_WATCH ? JSON.parse(process.env.FK_WATCH) : [["256 GB"]]
).map((terms) => terms.map((t) => t.toLowerCase()));

const ROME_ENDPOINT =
  "https://1.rome.api.flipkart.com/api/4/page/fetch?cacheFirst=false";

// Per-variant de-dupe: remember which variant titles we've already alerted on
// so we email once per restock, not every cycle. Re-armed if it goes away.
const notified = new Set();

// In-memory last-seen price for the selected variant (the one the URL points
// to — Flipkart only prices that variant in the response). Resets on restart,
// so the first check after a restart just records the price without alerting.
let lastPrice = null;

// Timestamped logging (IST).
function timestamp() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
function log(...args) {
  console.log(`[${timestamp()}]`, ...args);
}
function logError(...args) {
  console.error(`[${timestamp()}]`, ...args);
}

// Email via Resend's HTTP API (https:443), since Railway blocks SMTP.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";

const missingEnv = ["RESEND_API_KEY", "NOTIFY_EMAIL"].filter(
  (k) => !process.env[k]
);
if (missingEnv.length) {
  logError(
    `Missing env vars: ${missingEnv.join(", ")} — ` +
      `monitoring will run but emails cannot be sent.`
  );
}

// NOTIFY_EMAIL may be a comma-separated list; Resend accepts an array of
// recipients in a single send.
const RECIPIENTS = (process.env.NOTIFY_EMAIL || "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

async function sendMail(subject, html) {
  await axios.post(
    "https://api.resend.com/emails",
    { from: FROM_EMAIL, to: RECIPIENTS, subject, html },
    {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
}

async function sendAvailabilityEmail(title, url) {
  await sendMail(
    `🚨 ${title} is available on Flipkart`,
    `<h2>${title} is now available</h2>
     <p>Grab it before it sells out.</p>
     <a href="${url || PRODUCT_URL}">Buy Now on Flipkart</a>`
  );
  log(`Availability email sent for: ${title}`);
}

async function sendPriceEmail(title, oldPrice, newPrice) {
  const dir = newPrice > oldPrice ? "increased ⬆️" : "dropped ⬇️";
  await sendMail(
    `💰 ${title} price ${dir} to ₹${newPrice.toLocaleString("en-IN")}`,
    `<h2>${title}</h2>
     <p>Price ${dir} from <strong>₹${oldPrice.toLocaleString(
      "en-IN"
    )}</strong> to <strong>₹${newPrice.toLocaleString("en-IN")}</strong>.</p>
     <a href="${PRODUCT_URL}">View on Flipkart</a>`
  );
  log(`Price email sent for: ${title} (₹${oldPrice} → ₹${newPrice})`);
}

// Find the selected variant's price block ({finalPrice, mrp} as numbers).
function findSelectedPrice(obj) {
  let price = null;
  (function walk(o) {
    if (!o || typeof o !== "object" || price != null) return;
    if (typeof o.finalPrice === "number" && typeof o.mrp === "number") {
      price = o.finalPrice;
      return;
    }
    for (const k in o) walk(o[k]);
  })(obj);
  return price;
}

// Locate the { FSN: {available, ...} } products map anywhere in the response.
function findProductsMap(obj) {
  let found = null;
  (function walk(o) {
    if (!o || typeof o !== "object" || found) return;
    if (o.products && typeof o.products === "object") {
      const first = Object.values(o.products)[0];
      if (first && typeof first === "object" && "available" in first) {
        found = o.products;
        return;
      }
    }
    for (const k in o) walk(o[k]);
  })(obj);
  return found;
}

function matchesWatched(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return WATCHED.some((terms) => terms.every((term) => t.includes(term)));
}

async function checkStock() {
  try {
    const response = await axios.post(ROME_ENDPOINT, REQUEST_BODY, {
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.flipkart.com",
        Referer: "https://www.flipkart.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "X-User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 " +
          "FKUA/website/42/website/Desktop",
      },
      timeout: 15000,
    });

    const products = findProductsMap(response.data);

    if (!products) {
      logError("Could not find variants in response (page layout changed?)");
      return;
    }

    // Build the list of watched variants with their current availability.
    // Each variant object carries its own title and productUrl.
    const watched = [];
    for (const v of Object.values(products)) {
      const title = v.titles?.title;
      if (matchesWatched(title)) {
        watched.push({
          title,
          available: !!v.available,
          url: v.productUrl
            ? `https://www.flipkart.com${v.productUrl}`
            : PRODUCT_URL,
        });
      }
    }

    if (!watched.length) {
      logError(
        "No variants matched the watch list — check FK_WATCH / product page."
      );
      return;
    }

    for (const v of watched) {
      if (v.available && !notified.has(v.title)) {
        await sendAvailabilityEmail(v.title, v.url);
        notified.add(v.title);
        log(`AVAILABLE: ${v.title}`);
      } else if (v.available) {
        log(`${v.title} available (already notified)`);
      } else {
        notified.delete(v.title); // re-arm if it goes unavailable again
        log(`${v.title} — not available`);
      }
    }

    // Price change for the selected variant (the one the URL points to).
    const price = findSelectedPrice(response.data);
    if (price == null) {
      logError("Could not read selected-variant price this cycle");
    } else if (lastPrice == null) {
      lastPrice = price;
      log(`Recorded starting price: ₹${price.toLocaleString("en-IN")}`);
    } else if (Math.abs(price - lastPrice) > PRICE_THRESHOLD) {
      const selectedTitle =
        response.data?.RESPONSE?.pageData?.pageContext?.titles?.title ||
        "iPhone 17";
      await sendPriceEmail(selectedTitle, lastPrice, price);
      lastPrice = price;
    } else {
      log(`Price unchanged: ₹${price.toLocaleString("en-IN")}`);
    }
  } catch (err) {
    logError(err.response?.status || "", err.message);
  }
}

cron.schedule("*/5 * * * *", async () => {
  log("Checking Flipkart stock...");
  await checkStock();
});

log(
  `Flipkart iPhone 17 monitor started. Availability: ` +
    WATCHED.map((t) => t.join(" ")).join(" | ") +
    ` | Price alerts on selected variant (>₹${PRICE_THRESHOLD} change)`
);

// Run once immediately.
checkStock();
