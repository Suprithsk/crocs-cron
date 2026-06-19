const axios = require("axios");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
require("dotenv").config();
// url_key of the product to watch, read off the product page URL on crocs.in
// e.g. https://www.crocs.in/<url-key>.html
const PRODUCT_URL_KEY =
  process.env.PRODUCT_URL_KEY || "miami-thong-milk-chocolate-women-flip";

// The size to watch, matched against the variant SKU suffix.
// Crocs encodes size in the variant SKU, e.g. 209793-2JJ-W5 -> "W5".
// "W5" == men's 3 / women's 5 for this product.
const TARGET_SIZE = (process.env.TARGET_SIZE || "W5").toUpperCase();

const PRODUCT_URL = `https://www.crocs.in/${PRODUCT_URL_KEY}.html`;
const GRAPHQL_ENDPOINT = "https://www.crocs.in/graphql";

// Minimal query: per-size variant stock.
const STOCK_QUERY = `query getProductStock($urlKey:String!){products(filter:{url_key:{eq:$urlKey}}){items{name __typename ...on ConfigurableProduct{variants{product{sku stock_status __typename}__typename}}}__typename}}`;

let notificationSent = false;

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

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});

async function sendEmail(productName, sku) {
  await transporter.sendMail({
    from: process.env.EMAIL,
    to: process.env.NOTIFY_EMAIL,
    subject: `🚨 Crocs ${TARGET_SIZE} Back In Stock`,
    html: `
      <h2>${productName || "Crocs"} (size ${TARGET_SIZE}) is available</h2>
      <p>Variant <strong>${sku}</strong> is now in stock.</p>
      <a href="${PRODUCT_URL}">
        Buy Now
      </a>
    `,
  });

  log("Email sent");
}

// Match a variant to the target size via its SKU suffix (e.g. "-W5").
function matchesTargetSize(sku) {
  if (!sku) return false;
  const suffix = sku.split("-").pop().toUpperCase();
  return suffix === TARGET_SIZE;
}

async function checkStock() {
  try {
    const response = await axios.get(GRAPHQL_ENDPOINT, {
      params: {
        query: STOCK_QUERY,
        operationName: "getProductStock",
        variables: JSON.stringify({ urlKey: PRODUCT_URL_KEY }),
      },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      timeout: 15000,
    });

    if (response.data.errors) {
      logError("GraphQL errors:", JSON.stringify(response.data.errors));
      return;
    }

    const item = response.data?.data?.products?.items?.[0];

    if (!item) {
      logError(`No product found for url_key "${PRODUCT_URL_KEY}"`);
      return;
    }

    const variants = item.variants || [];
    const target = variants.find((v) => matchesTargetSize(v.product?.sku));

    if (!target) {
      const available = variants
        .map((v) => v.product?.sku?.split("-").pop())
        .filter(Boolean)
        .join(", ");
      logError(
        `Size "${TARGET_SIZE}" not found. Available sizes: ${available}`
      );
      return;
    }

    const inStock = target.product.stock_status === "IN_STOCK";

    if (inStock && !notificationSent) {
      await sendEmail(item.name, target.product.sku);
      notificationSent = true;
      log(`Stock found: ${item.name} size ${TARGET_SIZE}`);
    } else if (!inStock) {
      notificationSent = false;
      log(
        `Size ${TARGET_SIZE} still out of stock (${target.product.stock_status})`
      );
    } else {
      log(`Size ${TARGET_SIZE} in stock, notification already sent`);
    }
  } catch (err) {
    logError(err.message);
  }
}

cron.schedule("*/5 * * * *", async () => {
  log("Checking stock...");
  await checkStock();
});

log(`Crocs monitor started for "${PRODUCT_URL_KEY}" size ${TARGET_SIZE}`);

// Run once immediately so we don't wait a full minute on startup.
checkStock();
