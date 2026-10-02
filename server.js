const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

const TIKTOK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";


// --------------------------------------------------
// CORS
// --------------------------------------------------

app.use(cors());


// --------------------------------------------------
// Rate limiting
// --------------------------------------------------

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: {
    status: "error",
    error: "Too many requests. Please try again later."
  }
});

app.use("/video", limiter);


// --------------------------------------------------
// Home
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "success",
    service: "NetSaves API",
    message: "NetSaves downloader backend is online."
  });
});


// --------------------------------------------------
// Health
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "success"
  });
});


// --------------------------------------------------
// yt-dlp version
// --------------------------------------------------

app.get("/version", (req, res) => {

  const process = spawn("yt-dlp", ["--version"]);

  let output = "";

  process.stdout.on("data", (data) => {
    output += data.toString();
  });

  process.on("error", (error) => {
    return res.status(500).json({
      status: "error",
      error: error.message
    });
  });

  process.on("close", (code) => {

    if (code !== 0) {
      return res.status(500).json({
        status: "error",
        error: "Could not determine yt-dlp version."
      });
    }

    return res.json({
      status: "success",
      "yt-dlp": output.trim()
    });

  });

});


// --------------------------------------------------
// Helpers
// --------------------------------------------------

function isTikTokUrl(url) {

  try {

    const parsed = new URL(url);

    const host =
      parsed.hostname.toLowerCase();

    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:"
    ) && (
      host === "tiktok.com" ||
      host.endsWith(".tiktok.com")
    );

  } catch {

    return false;

  }

}


function getTikTokVideoId(url) {

  const match =
    url.match(/\/video\/(\d+)/);

  return match
    ? match[1]
    : null;

}


function runYtDlp(url, extraArgs = []) {

  return new Promise((resolve) => {

    const args = [
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      "--skip-download",
      "--js-runtimes",
      "deno",
      ...extraArgs,
      url
    ];

    const process =
      spawn("yt-dlp", args);

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("error", (error) => {

      resolve({
        success: false,
        error: error.message,
        stdout,
        stderr
      });

    });

    process.on("close", (code) => {

      if (code !== 0) {

        resolve({
          success: false,
          error:
            stderr.trim() ||
            "yt-dlp failed.",
          stdout,
          stderr,
          exit_code: code
        });

        return;

      }

      try {

        const data =
          JSON.parse(stdout);

        resolve({
          success: true,
          data
        });

      } catch (error) {

        resolve({
          success: false,
          error:
            "yt-dlp returned invalid JSON.",
          details:
            error.message,
          stdout,
          stderr
        });

      }

    });

  });

}


// --------------------------------------------------
// TikTok embed fallback
// --------------------------------------------------

async function getTikTokEmbedPage(videoId) {

  const embedUrl =
    "https://www.tiktok.com/embed/" +
    videoId;

  try {

    const response =
      await fetch(embedUrl, {
        method: "GET",
        headers: {
          "User-Agent": TIKTOK_USER_AGENT,
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language":
            "en-US,en;q=0.9"
        },
        redirect: "follow"
      });

    const html =
      await response.text();

    return {
      success: response.ok,
      status: response.status,
      url: response.url,
      html
    };

  } catch (error) {

    return {
      success: false,
      error: error.message,
      html: ""
    };

  }

}


// --------------------------------------------------
// Extract media URLs from TikTok embed HTML
// --------------------------------------------------

function extractTikTokMediaUrls(html) {

  const urls = [];

  if (!html) {
    return urls;
  }


  /*
   * Look for direct TikTok CDN video URLs.
   */

  const patterns = [

    /https?:\\?\/\\?\/[^"'\\\s]+tiktokcdn\.com[^"'\\\s]+/gi,

    /https?:\/\/[^"'\\\s]+tiktokcdn\.com[^"'\\\s]+/gi,

    /https?:\\?\/\\?\/[^"'\\\s]+\.mp4[^"'\\\s]*/gi,

    /https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s]*/gi

  ];


  patterns.forEach((pattern) => {

    const matches =
      html.match(pattern);

    if (!matches) {
      return;
    }

    matches.forEach((url) => {

      let clean =
        url;

      clean =
        clean
          .replace(/\\u0026/g, "&")
          .replace(/\\u002F/g, "/")
          .replace(/\\\//g, "/")
          .replace(/&amp;/g, "&")
          .replace(/\\+"/g, "")
          .replace(/^["']+/, "")
          .replace(/["']+$/, "");

      try {

        clean =
          JSON.parse(
            '"' +
            clean
              .replace(/\\/g, "\\\\")
              .replace(/"/g, '\\"') +
            '"'
          );

      } catch {

        // Keep original cleaned value.

      }

      if (
        /^https?:\/\//i.test(clean) &&
        (
          clean.includes("tiktokcdn.com") ||
          clean.includes(".mp4")
        )
      ) {

        if (
          !urls.includes(clean)
        ) {

          urls.push(clean);

        }

      }

    });

  });


  return urls;

}


// --------------------------------------------------
// Build a fallback TikTok response
// --------------------------------------------------

function buildTikTokFallbackResponse(
  url,
  videoId,
  mediaUrls
) {

  const formats =
    mediaUrls.map(
      (mediaUrl, index) => ({
        url: mediaUrl,
        format_id:
          "tiktok_embed_" +
          String(index + 1),
        ext: "mp4",
        resolution: "",
        width: null,
        height: null,
        filesize: null,
        vcodec: "unknown",
        acodec: "unknown"
      })
    );


  return {
    status: "success",
    title:
      "TikTok Video " +
      videoId,
    uploader: "",
    thumbnail: "",
    duration: 0,
    webpage_url: url,
    platform: "TikTok",
    formats
  };

}


// --------------------------------------------------
// Video endpoint
// --------------------------------------------------

app.get("/video", async (req, res) => {

  const url =
    req.query.url;


  // ----------------------------------------------
  // Validate URL
  // ----------------------------------------------

  if (!url) {

    return res.status(400).json({
      status: "error",
      error: "Missing video URL."
    });

  }


  try {

    const parsedUrl =
      new URL(url);

    if (
      parsedUrl.protocol !== "http:" &&
      parsedUrl.protocol !== "https:"
    ) {

      return res.status(400).json({
        status: "error",
        error:
          "Only HTTP and HTTPS URLs are supported."
      });

    }

  } catch {

    return res.status(400).json({
      status: "error",
      error: "Invalid video URL."
    });

  }


  const tiktok =
    isTikTokUrl(url);


  // ----------------------------------------------
  // Normal yt-dlp extraction
  // ----------------------------------------------

  const ytResult =
    await runYtDlp(
      url,
      tiktok
        ? [
            "--impersonate",
            "chrome"
          ]
        : []
    );


  // ----------------------------------------------
  // Successful normal extraction
  // ----------------------------------------------

  if (
    ytResult.success &&
    ytResult.data
  ) {

    const data =
      ytResult.data;


    return res.json({
      status: "success",
      title:
        data.title || "",
      uploader:
        data.uploader ||
        data.channel ||
        "",
      thumbnail:
        data.thumbnail || "",
      duration:
        data.duration || 0,
      webpage_url:
        data.webpage_url ||
        url,
      platform:
        data.extractor_key ||
        data.extractor ||
        "",
      formats:
        Array.isArray(data.formats)
          ? data.formats
              .filter(
                (format) =>
                  format.url
              )
              .map(
                (format) => ({
                  url:
                    format.url,
                  format_id:
                    format.format_id ||
                    "",
                  ext:
                    format.ext ||
                    "",
                  resolution:
                    format.resolution ||
                    "",
                  width:
                    format.width ||
                    null,
                  height:
                    format.height ||
                    null,
                  filesize:
                    format.filesize ||
                    format.filesize_approx ||
                    null,
                  vcodec:
                    format.vcodec ||
                    "",
                  acodec:
                    format.acodec ||
                    ""
                })
              )
          : []
    });

  }


  // ----------------------------------------------
  // TikTok fallback
  // ----------------------------------------------

  if (tiktok) {

    const videoId =
      getTikTokVideoId(url);


    if (videoId) {

      const embed =
        await getTikTokEmbedPage(
          videoId
        );


      if (embed.success) {

        const mediaUrls =
          extractTikTokMediaUrls(
            embed.html
          );


        if (
          mediaUrls.length > 0
        ) {

          return res.json(
            buildTikTokFallbackResponse(
              url,
              videoId,
              mediaUrls
            )
          );

        }

      }

    }

  }


  // ----------------------------------------------
  // Final error
  // ----------------------------------------------

  return res.status(500).json({
    status: "error",
    error:
      ytResult.error ||
      "The video could not be processed.",
    exit_code:
      ytResult.exit_code ||
      null,
    "yt-dlp":
      "2026.08.19"
  });

});


// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `NetSaves API running on port ${PORT}`
    );
  }
);
