import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const NOBITEX = "https://apiv2.nobitex.ir";

async function api(path) {
  const response = await fetch(NOBITEX + path, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Nobitex HTTP ${response.status}`);
  }

  return response.json();
}

function ema(values, period) {
  if (!values.length) return 0;

  const k = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) gain += change;
    else loss -= change;
  }

  gain /= period;
  loss /= period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const currentGain = Math.max(change, 0);
    const currentLoss = Math.max(-change, 0);

    gain = (gain * (period - 1) + currentGain) / period;
    loss = (loss * (period - 1) + currentLoss) / period;
  }

  if (loss === 0) return 100;

  return 100 - 100 / (1 + gain / loss);
}

async function getCandles(symbol, resolution) {
  const now = Math.floor(Date.now() / 1000);

  const days =
    resolution === "15"
      ? 5
      : 20;

  const from = now - days * 24 * 60 * 60;

  const url =
    `/market/udf/history?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=${resolution}` +
    `&from=${from}` +
    `&to=${now}`;

  const data = await api(url);

  if (
    data.s !== "ok" ||
    !Array.isArray(data.c) ||
    data.c.length < 60
  ) {
    throw new Error("Insufficient candle data");
  }

  return data;
}

function analyze(c15, c60) {
  const close15 = c15.c.map(Number);
  const close60 = c60.c.map(Number);
  const volume15 = c15.v.map(Number);

  const last = close15.at(-1);

  const ema20 = ema(close60.slice(-60), 20);
  const ema50 = ema(close60.slice(-80), 50);

  const currentRsi = rsi(close15, 14);

  const previousHigh = Math.max(
    ...close15.slice(-21, -1)
  );

  const breakout = last > previousHigh;

  const averageVolume =
    volume15
      .slice(-20)
      .reduce((a, b) => a + b, 0) /
    Math.min(20, volume15.length);

  const currentVolume = volume15.at(-1);

  let score = 0;

  // روند تایم‌فریم 1 ساعته
  if (ema20 > ema50) score += 3;

  // قیمت بالاتر از EMA20
  if (last > ema20) score += 1;

  // شکست سقف
  if (breakout) score += 2;

  // مومنتوم مناسب
  if (currentRsi >= 55 && currentRsi <= 72) {
    score += 2;
  }

  // افزایش حجم
  if (currentVolume > averageVolume * 1.25) {
    score += 2;
  }

  return {
    score,
    last,
    ema20,
    ema50,
    rsi: currentRsi,
    breakout,
    volumeConfirmed:
      currentVolume > averageVolume * 1.25
  };
}

async function scanMarket() {
  const market = await api(
    "/market/stats?dstCurrency=usdt"
  );

  const stats = market.stats || {};

  const markets = Object.entries(stats)
    .map(([pair, data]) => ({
      pair,
      data,
      volume: Number(data.volumeDst || 0),
      latest: Number(data.latest || 0),
      change: Number(data.dayChange || 0)
    }))
    .filter(
      x =>
        x.latest > 0 &&
        x.pair.toLowerCase().endsWith("-usdt")
    )
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 20);

  const signals = [];

  for (const market of markets) {
    try {
      const symbol = market.pair
        .replace("-", "")
        .toUpperCase();

      const [c15, c60] = await Promise.all([
        getCandles(symbol, "15"),
        getCandles(symbol, "60")
      ]);

      const result = analyze(c15, c60);

      // فیلتر سخت‌گیرانه
      if (result.score < 8) continue;

      const recentLow = Math.min(
        ...c15.l
          .slice(-12)
          .map(Number)
      );

      const entry = result.last;

      const minimumRisk = entry * 0.006;

      const risk = Math.max(
        entry - recentLow,
        minimumRisk
      );

      const stopLoss = entry - risk;

      const tp1 = entry + risk * 2;
      const tp2 = entry + risk * 3;

      signals.push({
        symbol: market.pair.toUpperCase(),

        score: result.score,

        setup: result.breakout
          ? "Breakout + Volume"
          : "Trend + Momentum",

        entry,
        stopLoss,
        tp1,
        tp2,

        rr: 2,

        rsi: Number(result.rsi.toFixed(2)),

        dayChange: market.change,

        volume24h: market.volume,

        generatedAt:
          new Date().toISOString(),

        live: true,

        tradingMode: "PAPER"
      });

    } catch {
      // اگر داده یک ارز ناقص بود،
      // اسکن بقیه ارزها ادامه پیدا می‌کند.
    }
  }

  return signals.sort(
    (a, b) => b.score - a.score
  );
}

const html = `
<!doctype html>
<html lang="fa" dir="rtl">

<head>
<meta charset="utf-8">

<meta
 name="viewport"
 content="width=device-width,initial-scale=1"
>

<meta
 name="theme-color"
 content="#0b1220"
>

<title>Nobitex Signal</title>

<style>

* {
 box-sizing:border-box;
}

body {
 margin:0;
 background:#0b1220;
 color:#eef2f7;
 font-family:
 -apple-system,
 BlinkMacSystemFont,
 "Segoe UI",
 sans-serif;
}

header {
 padding:16px;
 background:#111a2b;
 border-bottom:1px solid #22304a;

 display:flex;
 justify-content:space-between;
 align-items:center;
}

header b {
 display:block;
 font-size:20px;
}

header small {
 color:#91a0b7;
}

.live {
 color:#65e59b;
}

main {
 max-width:720px;
 margin:auto;
 padding:16px;
}

.hero {
 padding:20px 0;
}

.hero h1 {
 margin:0 0 8px;
}

.hero p {
 margin:0;
 color:#91a0b7;
}

.toolbar {
 display:flex;
 justify-content:space-between;
 align-items:center;
 margin-bottom:12px;
}

button {
 background:#2b66b1;
 color:white;
 border:0;
 border-radius:12px;
 padding:11px 18px;
 font-weight:700;
}

.card {
 background:#111a2b;
 border:1px solid #22304a;
 border-radius:16px;
 padding:16px;
 margin:10px 0;
}

.row {
 display:flex;
 justify-content:space-between;
 gap:10px;
}

.score {
 color:#65e59b;
 font-weight:800;
}

.muted {
 color:#91a0b7;
}

.grid {
 display:grid;
 grid-template-columns:1fr 1fr;
 gap:8px;
 margin:14px 0;
}

.metric {
 background:#151f32;
 padding:11px;
 border-radius:10px;
}

.metric small {
 display:block;
 color:#91a0b7;
 margin-bottom:5px;
}

</style>
</head>

<body>

<header>

<div>
<b>Nobitex Signal</b>
<small>Live USDT Scanner</small>
</div>

<span class="live">
● LIVE
</span>

</header>

<main>

<section class="hero">

<h1>
فرصت‌های بازار
</h1>

<p>
اسکن زنده بازارهای USDT نوبیتکس
</p>

</section>

<div class="toolbar">

<button onclick="scan()">
اسکن الآن
</button>

<span id="time">
—
</span>

</div>

<section id="signals"></section>

<div class="card">

<b>
وضعیت سیستم
</b>

<p
 id="status"
 class="muted"
>
در حال اتصال به نوبیتکس...
</p>

</div>

</main>

<script>

function formatNumber(value) {

 return Number(value)
   .toLocaleString(
     "en-US",
     {
       maximumFractionDigits:8
     }
   );

}

function signalCard(s) {

 return \`

 <article class="card">

 <div class="row">

 <b>
 \${s.symbol}
 </b>

 <span class="score">
 \${s.score}/10
 </span>

 </div>

 <p class="muted">
 \${s.setup}
 • R/R \${s.rr}
 </p>

 <div class="grid">

 <div class="metric">
 <small>Entry</small>
 <b>\${formatNumber(s.entry)}</b>
 </div>

 <div class="metric">
 <small>Stop Loss</small>
 <b>\${formatNumber(s.stopLoss)}</b>
 </div>

 <div class="metric">
 <small>TP1</small>
 <b>\${formatNumber(s.tp1)}</b>
 </div>

 <div class="metric">
 <small>TP2</small>
 <b>\${formatNumber(s.tp2)}</b>
 </div>

 </div>

 <p class="muted">
 RSI: \${s.rsi}
 • تغییر روزانه:
 \${s.dayChange.toFixed(2)}%
 </p>

 <p class="muted">
 حالت فعلی:
 PAPER TRADING
 </p>

 </article>

 \`;

}

async function scan() {

 const status =
 document.getElementById("status");

 const container =
 document.getElementById("signals");

 status.textContent =
 "در حال اسکن بازار...";

 container.innerHTML = "";

 try {

 const response =
 await fetch("/api/scan");

 const result =
 await response.json();

 if (result.status !== "ok") {
   throw new Error(
     result.message ||
     "Scan failed"
   );
 }

 if (!result.signals.length) {

   container.innerHTML = \`
   <div class="card">
   <b>
   فعلاً موقعیت مناسب پیدا نشد.
   </b>
   <p class="muted">
   فیلتر سیگنال عمداً سخت‌گیرانه است.
   </p>
   </div>
   \`;

 } else {

   container.innerHTML =
     result.signals
       .map(signalCard)
       .join("");

 }

 const now =
 new Date();

 document.getElementById("time")
   .textContent =
   now.toLocaleTimeString("fa-IR");

 status.textContent =
   "اتصال به داده بازار نوبیتکس برقرار است.";

 } catch(error) {

 status.textContent =
   "خطا در اتصال: " +
   error.message;

 }

}

scan();

setInterval(
 scan,
 15 * 60 * 1000
);

</script>

</body>

</html>
`;

function send(res, status, data, type = "application/json") {

 res.writeHead(
   status,
   {
     "Content-Type":
       `${type}; charset=utf-8`,
     "Access-Control-Allow-Origin":
       "*"
   }
 );

 res.end(
   type === "text/html"
     ? data
     : JSON.stringify(data)
 );

}

const server =
 http.createServer(
 async (req, res) => {

  try {

   if (req.method === "OPTIONS") {

    res.writeHead(
      204,
      {
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Allow-Headers":
          "content-type"
      }
    );

    return res.end();
   }

   if (req.url === "/") {

    return send(
      res,
      200,
      html,
      "text/html"
    );

   }

   if (req.url === "/api/health") {

    return send(
      res,
      200,
      {
        ok:true,
        source:"Nobitex",
        mode:"PAPER"
      }
    );

   }

   if (req.url === "/api/market") {

    const data =
      await api(
        "/market/stats?dstCurrency=usdt"
      );

    return send(
      res,
      200,
      data
    );

   }

   if (req.url === "/api/scan") {

    const signals =
      await scanMarket();

    return send(
      res,
      200,
      {
        status:"ok",
        signals
      }
    );

   }

   return send(
     res,
     404,
     {
       error:"Not found"
     }
   );

  } catch(error) {

   console.error(error);

   return send(
     res,
     500,
     {
       status:"error",
       message:error.message
     }
   );

  }

 }
);

server.listen(
 PORT,
 () => {
  console.log(
    "Nobitex Signal running on port",
    PORT
  );
 }
);
