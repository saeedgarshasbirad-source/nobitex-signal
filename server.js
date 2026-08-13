import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const NOBITEX_API = "https://apiv2.nobitex.ir";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || "mailto:admin@example.com";

const subscriptions = new Map();
const notifiedSignals = new Map();

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

async function nobitex(pathname) {
  const response = await fetch(NOBITEX_API + pathname, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Nobitex HTTP ${response.status}`);
  }

  return response.json();
}

function ema(values, period) {
  if (!values.length) return 0;

  const multiplier = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      values[i] - values[i - 1];

    if (change >= 0) {
      gain += change;
    } else {
      loss -= change;
    }
  }

  gain /= period;
  loss /= period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] - values[i - 1];

    gain =
      (gain * (period - 1) +
        Math.max(change, 0)) /
      period;

    loss =
      (loss * (period - 1) +
        Math.max(-change, 0)) /
      period;
  }

  if (loss === 0) return 100;

  const rs = gain / loss;

  return 100 - 100 / (1 + rs);
}

async function getCandles(
  symbol,
  resolution
) {
  const now =
    Math.floor(Date.now() / 1000);

  const days =
    resolution === "15"
      ? 5
      : 20;

  const from =
    now - days * 24 * 60 * 60;

  const url =
    `/market/udf/history` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=${resolution}` +
    `&from=${from}` +
    `&to=${now}`;

  const data = await nobitex(url);

  if (
    data.s !== "ok" ||
    !Array.isArray(data.c) ||
    data.c.length < 60
  ) {
    throw new Error(
      "Insufficient candle data"
    );
  }

  return data;
}

function analyzeMarket(
  candles15,
  candles60
) {
  const close15 =
    candles15.c.map(Number);

  const low15 =
    candles15.l.map(Number);

  const volume15 =
    candles15.v.map(Number);

  const close60 =
    candles60.c.map(Number);

  const currentPrice =
    close15.at(-1);

  const ema20 =
    ema(close60.slice(-60), 20);

  const ema50 =
    ema(close60.slice(-80), 50);

  const currentRsi =
    rsi(close15, 14);

  const previousHigh =
    Math.max(
      ...close15.slice(-21, -1)
    );

  const breakout =
    currentPrice > previousHigh;

  const averageVolume =
    volume15
      .slice(-20)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) /
    Math.min(
      20,
      volume15.length
    );

  const currentVolume =
    volume15.at(-1);

  let score = 0;

  if (ema20 > ema50) {
    score += 3;
  }

  if (currentPrice > ema20) {
    score += 1;
  }

  if (breakout) {
    score += 2;
  }

  if (
    currentRsi >= 55 &&
    currentRsi <= 72
  ) {
    score += 2;
  }

  if (
    currentVolume >
    averageVolume * 1.25
  ) {
    score += 2;
  }

  const recentLow =
    Math.min(
      ...low15.slice(-12)
    );

  const minimumRisk =
    currentPrice * 0.006;

  const risk = Math.max(
    currentPrice - recentLow,
    minimumRisk
  );

  return {
    score,

    entry: currentPrice,

    stopLoss:
      currentPrice - risk,

    tp1:
      currentPrice + risk * 2,

    tp2:
      currentPrice + risk * 3,

    rsi: currentRsi,

    breakout,

    volumeConfirmed:
      currentVolume >
      averageVolume * 1.25
  };
}

async function scanMarket() {
  const market =
    await nobitex(
      "/market/stats?dstCurrency=usdt"
    );

  const stats =
    market.stats || {};

  const markets =
    Object.entries(stats)
      .map(([pair, data]) => ({
        pair,
        latest:
          Number(data.latest || 0),
        volume:
          Number(
            data.volumeDst || 0
          ),
        dayChange:
          Number(
            data.dayChange || 0
          )
      }))
      .filter(
        item =>
          item.latest > 0 &&
          item.pair
            .toLowerCase()
            .endsWith("-usdt")
      )
      .sort(
        (a, b) =>
          b.volume - a.volume
      )
      .slice(0, 20);

  const signals = [];

  for (const market of markets) {
    try {
      const symbol =
        market.pair
          .replace("-", "")
          .toUpperCase();

      const [
        candles15,
        candles60
      ] = await Promise.all([
        getCandles(symbol, "15"),
        getCandles(symbol, "60")
      ]);

      const analysis =
        analyzeMarket(
          candles15,
          candles60
        );

      if (analysis.score < 8) {
        continue;
      }

      signals.push({
        symbol:
          market.pair.toUpperCase(),

        score:
          analysis.score,

        setup:
          analysis.breakout
            ? "Breakout + Volume"
            : "Trend + Momentum",

        entry:
          analysis.entry,

        stopLoss:
          analysis.stopLoss,

        tp1:
          analysis.tp1,

        tp2:
          analysis.tp2,

        rr: 2,

        rsi:
          Number(
            analysis.rsi.toFixed(2)
          ),

        dayChange:
          market.dayChange,

        volume24h:
          market.volume,

        generatedAt:
          new Date().toISOString(),

        live: true,

        tradingMode:
          "PAPER"
      });
    } catch (error) {
      console.log(
        "Skipped",
        market.pair,
        error.message
      );
    }
  }

  return signals.sort(
    (a, b) =>
      b.score - a.score
  );
}

async function sendPushNotification(
  signal
) {
  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY ||
    subscriptions.size === 0
  ) {
    return;
  }

  const signalKey =
    `${signal.symbol}:${Math.round(
      signal.entry
    )}`;

  const last =
    notifiedSignals.get(
      signalKey
    ) || 0;

  const sixHours =
    6 * 60 * 60 * 1000;

  if (
    Date.now() - last <
    sixHours
  ) {
    return;
  }

  const payload =
    JSON.stringify({
      title:
        `سیگنال ${signal.symbol}`,

      body:
        `امتیاز ${signal.score}/10 | ورود ${signal.entry} | حدضرر ${signal.stopLoss}`,

      url: "/"
    });

  for (
    const [
      id,
      subscription
    ] of subscriptions
  ) {
    try {
      await webpush.sendNotification(
        subscription,
        payload
      );
    } catch (error) {
      if (
        error.statusCode === 404 ||
        error.statusCode === 410
      ) {
        subscriptions.delete(id);
      }
    }
  }

  notifiedSignals.set(
    signalKey,
    Date.now()
  );
}

async function scanAndNotify() {
  try {
    const signals =
      await scanMarket();

    for (const signal of signals) {
      await sendPushNotification(
        signal
      );
    }

    console.log(
      new Date().toISOString(),
      "Scan:",
      signals.length,
      "signals"
    );
  } catch (error) {
    console.error(
      "Scanner error:",
      error.message
    );
  }
}

function sendJson(
  response,
  status,
  data
) {
  response.writeHead(
    status,
    {
      "Content-Type":
        "application/json; charset=utf-8",

      "Access-Control-Allow-Origin":
        "*"
    }
  );

  response.end(
    JSON.stringify(data)
  );
}

const server =
  http.createServer(
    async (
      request,
      response
    ) => {
      try {
        const url =
          new URL(
            request.url,
            `http://${request.headers.host}`
          );

        if (
          request.method ===
          "OPTIONS"
        ) {
          response.writeHead(
            204,
            {
              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Headers":
                "content-type"
            }
          );

          return response.end();
        }

        if (
          url.pathname ===
          "/api/health"
        ) {
          return sendJson(
            response,
            200,
            {
              ok: true,

              mode:
                "PAPER",

              source:
                "Nobitex",

              pushConfigured:
                Boolean(
                  VAPID_PUBLIC_KEY &&
                  VAPID_PRIVATE_KEY
                )
            }
          );
        }

        if (
          url.pathname ===
          "/api/vapid-public-key"
        ) {
          return sendJson(
            response,
            200,
            {
              key:
                VAPID_PUBLIC_KEY
            }
          );
        }

        if (
          url.pathname ===
          "/api/scan"
        ) {
          const signals =
            await scanMarket();

          return sendJson(
            response,
            200,
            {
              status:
                "ok",

              signals
            }
          );
        }

        if (
          url.pathname ===
            "/api/push/subscribe" &&
          request.method === "POST"
        ) {
          let body = "";

          for await (
            const chunk of request
          ) {
            body += chunk;
          }

          const subscription =
            JSON.parse(body);

          const id =
            Buffer.from(
              JSON.stringify(
                subscription
              )
            ).toString(
              "base64url"
            );

          subscriptions.set(
            id,
            subscription
          );

          return sendJson(
            response,
            200,
            {
              ok: true
            }
          );
        }

        if (
          url.pathname ===
          "/manifest.webmanifest"
        ) {
          const file =
            await readFile(
              path.join(
                __dirname,
                "public",
                "manifest.webmanifest"
              )
            );

          response.writeHead(
            200,
            {
              "Content-Type":
                "application/manifest+json"
            }
          );

          return response.end(
            file
          );
        }

        if (
          url.pathname ===
          "/sw.js"
        ) {
          const file =
            await readFile(
              path.join(
                __dirname,
                "public",
                "sw.js"
              )
            );

          response.writeHead(
            200,
            {
              "Content-Type":
                "application/javascript"
            }
          );

          return response.end(
            file
          );
        }

        if (
          url.pathname ===
          "/"
        ) {
          const file =
            await readFile(
              path.join(
                __dirname,
                "public",
                "index.html"
              )
            );

          response.writeHead(
            200,
            {
              "Content-Type":
                "text/html; charset=utf-8"
            }
          );

          return response.end(
            file
          );
        }

        response.writeHead(
          404
        );

        response.end(
          "Not found"
        );
      } catch (error) {
        console.error(error);

        sendJson(
          response,
          500,
          {
            status:
              "error",

            message:
              error.message
          }
        );
      }
    }
  );

server.listen(
  PORT,
  () => {
    console.log(
      `Nobitex Signal running on port ${PORT}`
    );
  }
);

// اسکن خودکار هر ۱۵ دقیقه
setInterval(
  scanAndNotify,
  15 * 60 * 1000
);

scanAndNotify();