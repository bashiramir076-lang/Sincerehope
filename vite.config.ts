import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";
import express from "express";
import bcrypt from "bcryptjs";

// =============================================================================
// Manus Debug Collector - Vite Plugin
// Writes browser logs directly to files, trimmed when exceeding size limit
// =============================================================================

const PROJECT_ROOT = import.meta.dirname;
const LOG_DIR = path.join(PROJECT_ROOT, ".manus-logs");
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024; // 1MB per log file
const TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6); // Trim to 60% to avoid constant re-trimming

type LogSource = "browserConsole" | "networkRequests" | "sessionReplay";

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function trimLogFile(logPath: string, maxSize: number) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }

    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines: string[] = [];
    let keptBytes = 0;

    // Keep newest lines (from end) that fit within 60% of maxSize
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}\n`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }

    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
    /* ignore trim errors */
  }
}

function writeToLogFile(source: LogSource, entries: unknown[]) {
  if (entries.length === 0) return;

  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);

  // Format entries with timestamps
  const lines = entries.map((entry) => {
    const ts = new Date().toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });

  // Append to log file
  fs.appendFileSync(logPath, `${lines.join("\n")}\n`, "utf-8");

  // Trim if exceeds max size
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}

/**
 * Vite plugin to collect browser debug logs
 * - POST /__manus__/logs: Browser sends logs, written directly to files
 * - Files: browserConsole.log, networkRequests.log, sessionReplay.log
 * - Auto-trimmed when exceeding 1MB (keeps newest entries)
 */
function vitePluginManusDebugCollector(): Plugin {
  return {
    name: "manus-debug-collector",

    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true,
            },
            injectTo: "head",
          },
        ],
      };
    },

    configureServer(server: ViteDevServer) {
      // Admin password storage (in-memory for development)
      let adminPasswordHash = "$2b$10$p1TuTbf01.UANkUTg16dHuW9YPdH7SC6Kj3NGHIenreeZDTmeX3.u"; // bcrypt hash of "admin123"
      
      // Mock database for development
      const mockData = {
        categories: [] as any[],
        items: [] as any[],
        adminSettings: {
          whatsappNumber: null as string | null,
        }
      };

      // API Routes middleware
      server.middlewares.use(express.json({ limit: '100mb' }));
      server.middlewares.use(express.urlencoded({ limit: '100mb', extended: true }));

      // API: Verify password
      server.middlewares.use("/api/admin/verify-password", (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        const { password } = req.body as { password?: string };

        if (!password) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Password required" }));
          return;
        }

        try {
          const isValid = bcrypt.compareSync(password, adminPasswordHash);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: isValid }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Verification failed" }));
        }
      });

      // API: Change password
      server.middlewares.use("/api/admin/change-password", (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        const { currentPassword, newPassword } = req.body as {
          currentPassword?: string;
          newPassword?: string;
        };

        if (!currentPassword || !newPassword) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Current and new password required" }));
          return;
        }

        try {
          // Verify current password
          const isValid = bcrypt.compareSync(currentPassword, adminPasswordHash);
          if (!isValid) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Current password is incorrect" }));
            return;
          }

          // Hash new password
          const newHash = bcrypt.hashSync(newPassword, 10);
          adminPasswordHash = newHash;

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, message: "Password changed successfully" }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Password change failed" }));
        }
      });

      // API: Get admin settings
      server.middlewares.use("/api/admin/settings", (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          whatsappNumber: mockData.adminSettings.whatsappNumber,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
      });

      // API: Update WhatsApp number
      server.middlewares.use("/api/admin/update-whatsapp", (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        const { password, whatsappNumber } = req.body as {
          password?: string;
          whatsappNumber?: string;
        };

        if (!password) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "كلمة المرور مطلوبة" }));
          return;
        }

        try {
          const isValid = bcrypt.compareSync(password, adminPasswordHash);
          if (!isValid) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "كلمة المرور غير صحيحة" }));
            return;
          }

          if (!whatsappNumber) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "رقم الواتساب مطلوب" }));
            return;
          }

          mockData.adminSettings.whatsappNumber = whatsappNumber;

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, message: "تم تحديث رقم الواتساب بنجاح" }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "حدث خطأ في تحديث رقم الواتساب" }));
        }
      });

      // API: Portfolio Categories (GET, POST, PUT, DELETE)
      server.middlewares.use("/api/portfolio/categories", (req, res, next) => {
        const url = req.url || "";
        const method = req.method;

        // Handle /api/portfolio/categories (GET, POST)
        if (url === "/" || url === "") {
          if (method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(mockData.categories));
            return;
          }

          if (method === "POST") {
            const { name, slug, icon, description } = req.body as any;
            if (!name || !slug) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "الاسم والـ slug مطلوبان" }));
              return;
            }
            const newCategory = {
              id: mockData.categories.length + 1,
              name, slug, icon, description,
              items: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            mockData.categories.push(newCategory);
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify(newCategory));
            return;
          }
        }

        // Handle /api/portfolio/categories/:id (PUT, DELETE)
        const idMatch = url.match(/^\/(\d+)$/);
        if (idMatch) {
          const id = parseInt(idMatch[1]);
          const index = mockData.categories.findIndex((c) => c.id === id);

          if (index === -1) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "الفئة غير موجودة" }));
            return;
          }

          if (method === "PUT") {
            const { name, slug, icon, description } = req.body as any;
            const category = mockData.categories[index];
            if (name) category.name = name;
            if (slug) category.slug = slug;
            if (icon !== undefined) category.icon = icon;
            if (description !== undefined) category.description = description;
            category.updatedAt = new Date().toISOString();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(category));
            return;
          }

          if (method === "DELETE") {
            const deleted = mockData.categories.splice(index, 1)[0];
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, category: deleted }));
            return;
          }
        }

        next();
      });

      // API: Upload Handler - Real file upload for development
      const uploadsDir = path.resolve(process.cwd(), "uploads");
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      server.middlewares.use("/api/upload", (req, res, next) => {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        const chunks: Buffer[] = [];

        req.on("data", (chunk) => {
          chunks.push(chunk);
        });

        req.on("end", async () => {
          try {
            // Parse multipart form data
            const contentType = req.headers["content-type"] || "";
            const boundary = contentType.split("boundary=")[1];
            if (!boundary) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "No boundary found" }));
              return;
            }

            const buffer = Buffer.concat(chunks);
            const parts = buffer.toString("binary").split(`--${boundary}`);
            
            let fileBuffer: Buffer | null = null;
            let originalName = "file";
            let fileType = "image";

            for (const part of parts) {
              if (part.includes("Content-Disposition: form-data")) {
                const filenameMatch = part.match(/filename="([^"]+)"/);
                if (filenameMatch) {
                  originalName = filenameMatch[1];
                  const ext = path.extname(originalName).toLowerCase();
                  fileType = ext.match(/\.(mp4|webm|mov|avi)$/i) ? "video" : "image";
                  
                  const headerEnd = part.indexOf("\r\n\r\n");
                  const footerStart = part.lastIndexOf("\r\n");
                  if (headerEnd !== -1 && footerStart !== -1) {
                    const fileData = part.substring(headerEnd + 4, footerStart);
                    fileBuffer = Buffer.from(fileData, "binary");
                  }
                  break;
                }
              }
            }

            if (!fileBuffer) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "No file found in upload" }));
              return;
            }

            // Save file to disk
            const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
            const filename = uniqueSuffix + path.extname(originalName);
            const filepath = path.join(uploadsDir, filename);
            
            fs.writeFileSync(filepath, fileBuffer);

            const fileUrl = `/uploads/${filename}`;
            const fileKey = filename;

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              fileUrl,
              fileKey,
              fileType,
              originalName
            }));
          } catch (error) {
            console.error("Upload error:", error);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Upload failed" }));
          }
        });
      });

      // API: Portfolio Items (GET, POST, PUT, DELETE)
      server.middlewares.use("/api/portfolio/items", (req, res, next) => {
        const url = req.url || "";
        const method = req.method;

        // Handle /api/portfolio/items (GET, POST)
        if (url === "/" || url === "") {
          if (method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(mockData.items));
            return;
          }

          if (method === "POST") {
            const { categoryId, title, description, fileUrl, fileType, thumbnail, order } = req.body as any;
            if (!categoryId || !title || !fileUrl || !fileType) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "البيانات المطلوبة غير مكتملة" }));
              return;
            }
            const newItem = {
              id: mockData.items.length + 1,
              categoryId: parseInt(categoryId),
              title, description, fileUrl, fileType, thumbnail,
              order: order || 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            mockData.items.push(newItem);
            const category = mockData.categories.find((c) => c.id === newItem.categoryId);
            if (category) {
              if (!category.items) category.items = [];
              category.items.push(newItem);
            }
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify(newItem));
            return;
          }
        }

        // Handle /api/portfolio/items/category/:categoryId (GET)
        const categoryMatch = url.match(/^\/category\/(\d+)$/);
        if (categoryMatch && method === "GET") {
          const categoryId = parseInt(categoryMatch[1]);
          const filteredItems = mockData.items.filter(i => i.categoryId === categoryId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(filteredItems));
          return;
        }

        // Handle /api/portfolio/items/:id (PUT, DELETE)
        const idMatch = url.match(/^\/(\d+)$/);
        if (idMatch) {
          const id = parseInt(idMatch[1]);
          const index = mockData.items.findIndex((i) => i.id === id);

          if (index === -1) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "العمل غير موجود" }));
            return;
          }

          if (method === "PUT") {
            const updates = req.body as any;
            const item = mockData.items[index];
            Object.assign(item, updates);
            if (updates.categoryId) item.categoryId = parseInt(updates.categoryId);
            item.updatedAt = new Date().toISOString();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(item));
            return;
          }

          if (method === "DELETE") {
            const deleted = mockData.items.splice(index, 1)[0];
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, item: deleted }));
            return;
          }
        }

        next();
      });

      // Serve uploads directory
      server.middlewares.use("/uploads", express.static(uploadsDir, {
        maxAge: "1d",
        etag: true,
        lastModified: true,
        setHeaders: (res, p) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          if (p.endsWith('.mp4') || p.endsWith('.webm') || p.endsWith('.mov')) {
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Accept-Ranges', 'bytes');
          }
        }
      }));

      // POST /__manus__/logs: Browser sends logs (written directly to files)
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }

        const handlePayload = (payload: any) => {
          // Write logs directly to files
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };

        const reqBody = (req as { body?: unknown }).body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });

        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    },
  };
}

function vitePluginStorageProxy(): Plugin {
  return {
    name: "manus-storage-proxy",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/manus-storage", async (req, res) => {
        const key = req.url?.replace(/^\//, "");
        if (!key) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing storage key");
          return;
        }

        const forgeBaseUrl = (process.env.BUILT_IN_FORGE_API_URL || "").replace(/\/+$/, "");
        const forgeKey = process.env.BUILT_IN_FORGE_API_KEY;
        if (!forgeBaseUrl || !forgeKey) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Storage proxy not configured");
          return;
        }

        try {
          const forgeUrl = new URL("v1/storage/presign/get", forgeBaseUrl + "/");
          forgeUrl.searchParams.set("path", key);
          const forgeResp = await fetch(forgeUrl, {
            headers: { Authorization: `Bearer ${forgeKey}` },
          });
          if (!forgeResp.ok) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("Storage backend error");
            return;
          }
          const { url } = (await forgeResp.json()) as { url: string };
          if (!url) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("Empty signed URL");
            return;
          }
          res.writeHead(307, { Location: url, "Cache-Control": "no-store" });
          res.end();
        } catch {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Storage proxy error");
        }
      });
    },
  };
}

const plugins = [react(), tailwindcss(), jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector(), vitePluginStorageProxy()];

export default defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: false, // Will find next available port if 3000 is busy
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1",
    ],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
