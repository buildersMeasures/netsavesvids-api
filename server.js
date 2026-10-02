const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;
const POT_PORT = 4416;

// ----------------------------------------
// CORS
// ----------------------------------------

app.use(cors());

app.use(express.json());

// ----------------------------------------
// Rate limiting
// ----------------------------------------

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    error: "Too many requests. Try again later."
  }
});

app.use(limiter);

// ----------------------------------------
// Start BgUtils PO Token provider
// ----------------------------------------

function startPotProvider() {
  const potProvider = spawn(
    "bgutil-ytdlp-pot-provider",
    [
      "--port",
      String(POT_PORT),
      "--host",
      "127.0.0.1"
    ],
    {
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  potProvider.stdout.on("data", (data) => {
    console.log(
      "[PO Token Provider]",
      data.toString().trim()
    );
  });

  potProvider.stderr.on("data", (data) => {
    console.error(
      "[PO Token Provider]",
      data.toString().trim()
    );
  });

  potProvider.on("error", (error) => {
    console.error(
      "PO Token provider failed to start:",
      error.message
    );
  });

  potProvider.on("close", (code) => {
    console.log(
      `PO Token provider stopped with code ${code}`
    );
  });

  return potProvider;
}

// ----------------------------------------
// Health check
// ----------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

// ----------------------------------------
// Main endpoint
// ----------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "NetSaves Downloader API"
  });
});

// ----------------------------------------
// URL validation
// ----------------------------------------

function validateVideoUrl(videoUrl) {
  try {
    const parsed = new URL(videoUrl);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return false;
    }

    return true;

  } catch {
    return false;
  }
}

// ----------------------------------------
// Run yt-dlp
// ----------------------------------------

function getVideoInfo(videoUrl) {
  return new Promise((resolve, reject) => {

    const args = [
      "--no-warnings",
      "--no-playlist",
      "--dump-single-json",
      "--skip-download",

      // Use the BgUtils PO Token provider
      "--extractor-args",
      "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",

      // Use Deno for YouTube JavaScript challenges
      "--js-runtimes",
      "deno",

      // Preferred downloadable format
      "--format",
      "best[ext=mp4][acodec!=none][vcodec!=none]/best[ext=mp4]/best",

      videoUrl
    ];

    const ytdlp = spawn("yt-dlp", args);

    let output = "";
    let errorOutput = "";

    ytdlp.stdout.on("data", (data) => {
      output += data.toString();
    });

    ytdlp.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    ytdlp.on("error", (error) => {
      reject(error.message);
    });

    ytdlp.on("close", (code) => {

      if (code !== 0) {

        return reject(
          errorOutput.trim() ||
          "yt-dlp failed to process this URL."
        );
      }

      try {

        const data = JSON.parse(output);

        if (!data.url) {

          return reject(
            "No downloadable video format was found."
          );
        }

        resolve({
          title: data.title || "Video",
          thumbnail: data.thumbnail || "",
          duration: data.duration || 0,
          uploader: data.uploader || "",
          webpage_url: data.webpage_url || videoUrl,
          download_url: data.url,
          ext: data.ext || "mp4",
          filesize:
            data.filesize ||
            data.filesize_approx ||
            null
        });

      } catch (error) {

        reject(
          "Failed to parse yt-dlp output."
        );
      }
    });
  });
}

// ----------------------------------------
// /video
// ----------------------------------------

app.get("/video", async (req, res) => {

  const videoUrl = req.query.url;

  if (!videoUrl) {

    return res.status(400).json({
      status: "error",
      error: "Missing required parameter: url"
    });
  }

  if (!validateVideoUrl(videoUrl)) {

    return res.status(400).json({
      status: "error",
      error: "Invalid video URL."
    });
  }

  try {

    console.log(
      "Processing video:",
      videoUrl
    );

    const result =
      await getVideoInfo(videoUrl);

    res.json({
      status: "success",
      ...result
    });

  } catch (error) {

    console.error(
      "yt-dlp error:",
      error
    );

    res.status(500).json({
      status: "error",
      error: error.toString()
    });
  }
});

// ----------------------------------------
// Start PO Token provider
// ----------------------------------------

startPotProvider();

// ----------------------------------------
// Start Express server
// ----------------------------------------

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `NetSaves API running on port ${PORT}`
    );

    console.log(
      `PO Token provider expected at 127.0.0.1:${POT_PORT}`
    );
  }
);
