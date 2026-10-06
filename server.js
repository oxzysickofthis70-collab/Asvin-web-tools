import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

let browserPromise = null;
async function getBrowser(){
  if(!browserPromise){
    browserPromise = puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1366,768",
      ],
    });
  }
  return browserPromise;
}

app.get("/extract", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "missing url" });
  if (!/^https?:\/\//i.test(target)) {
    return res.status(400).json({ error: "invalid url" });
  }

  let page;
  const externalCSS = [];
  const externalJS = [];

  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    });

    page.on("response", async (response) => {
      try {
        const url = response.url();
        const type = response.headers()["content-type"] || "";
        const status = response.status();
        if (status >= 400) return;

        if (type.includes("text/css")) {
          const text = await response.text().catch(() => "");
          if (text) externalCSS.push({ url, text });
        } else if (
          type.includes("javascript") ||
          type.includes("ecmascript") ||
          /\.m?js(\?|$)/i.test(url)
        ) {
          const text = await response.text().catch(() => "");
          if (text) externalJS.push({ url, text });
        }
      } catch {}
    });

    await page.goto(target, {
      waitUntil: "networkidle2",
      timeout: 45000,
    });

    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let total = 0;
        const step = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          total += step;
          if (total >= document.body.scrollHeight || total > 6000) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 120);
      });
    });

    await new Promise((r) => setTimeout(r, 800));

    const html = await page.content();

    const inlineCSS = await page.evaluate(() =>
      Array.from(document.querySelectorAll("style"))
        .map((s) => s.textContent.trim())
        .filter(Boolean)
    );

    const inlineJS = await page.evaluate(() =>
      Array.from(document.querySelectorAll("script:not([src])"))
        .map((s) => s.textContent.trim())
        .filter(Boolean)
    );

    const cssParts = [];
    inlineCSS.forEach((css) => cssParts.push("/* INLINE CSS */\n" + css));
    externalCSS.forEach(({ url, text }) =>
      cssParts.push("/* " + url + " */\n" + text)
    );

    const jsParts = [];
    inlineJS.forEach((js) => jsParts.push("/* INLINE JAVASCRIPT */\n" + js));
    externalJS.forEach(({ url, text }) =>
      jsParts.push("/* " + url + " */\n" + text)
    );

    res.set("Access-Control-Allow-Origin", "*");
    res.json({
      html,
      css: cssParts.join("\n\n"),
      js: jsParts.join("\n\n"),
      meta: {
        url: target,
        finalURL: page.url(),
        title: await page.title().catch(() => ""),
        cssCount: inlineCSS.length + externalCSS.length,
        jsCount: inlineJS.length + externalJS.length,
      },
    });
  } catch (err) {
    console.error("Extract error:", err.message);
    res.status(500).json({
      error: "extract_failed",
      message: err.message,
    });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n  ✅ ASVIN (Puppeteer) → http://localhost:${PORT}\n`);
});

process.on("SIGINT", async () => {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close().catch(() => {});
  }
  process.exit(0);
});