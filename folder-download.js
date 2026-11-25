const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const maxBytes = 256 * 1024 * 1024;
const maxEntries = 10000;

function isArchivePath(value) {
    return typeof value === "string" && Buffer.byteLength(value) <= 1024 &&
        !/[\x00-\x1f\x7f\\:]/.test(value) &&
        value.split("/").every((part) => part.replace(/[. ]+$/, "").length > 0);
}

function isObjectETag(value) {
    return typeof value === "string" && /^"[a-f0-9]+(?:-\d+)?"$/i.test(value);
}

function abortOnClose(response) {
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    return controller.signal;
}

module.exports = function registerFolderDownloads(app, s3, bucket) {
    app.get("/folder-download/client.js", (_req, res) => {
        res.sendFile(path.join(__dirname, "templates", "folder-download.js"));
    });
    app.get("/folder-download/zip-worker.js", (_req, res) => {
        res.sendFile(path.join(__dirname, "templates", "zip-worker.js"));
    });
    app.get("/folder-download/jszip.min.js", (_req, res) => {
        res.sendFile(path.join(__dirname, "templates", "vendor", "jszip.min.js"));
    });

    app.get("/folder-download/manifest", async (req, res) => {
        const { folder, cursor } = req.query;
        if (!isArchivePath(folder) || (cursor !== undefined && (typeof cursor !== "string" || !cursor))) {
            return res.status(400).send({ error: "A valid folder and cursor are required" });
        }

        const signal = abortOnClose(res);
        const prefix = `${folder}/`;
        try {
            const result = await s3.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                MaxKeys: 1000,
                ContinuationToken: cursor
            }), { abortSignal: signal });
            const nextCursor = result.IsTruncated ? result.NextContinuationToken : null;
            if (result.IsTruncated && (!nextCursor || nextCursor === cursor)) {
                throw new Error("R2 did not return a usable continuation token");
            }

            const objects = result.Contents || [];
            const entries = [];
            for (const { Key, Size, ETag } of objects) {
                if (typeof Key !== "string" || !Key.startsWith(prefix)) {
                    throw new Error("R2 returned a key outside the folder");
                }
                const relativePath = Key.slice(prefix.length);
                if (relativePath === "" || relativePath === ".placeholder") continue;

                const archivePath = relativePath.replace(/(?:\/\.placeholder|\/)$/, "");
                if (!isArchivePath(archivePath)) {
                    return res.status(409).send({ error: "The folder contains a path that cannot be included safely in a ZIP" });
                }
                if (archivePath !== relativePath) {
                    entries.push({ path: archivePath, directory: true });
                } else {
                    if (!Number.isSafeInteger(Size) || Size < 0 || !isObjectETag(ETag)) {
                        throw new Error("R2 did not return valid file metadata");
                    }
                    entries.push({ path: archivePath, size: Size, etag: ETag });
                }
            }
            return res.set("Cache-Control", "no-store").send({
                entries, nextCursor, found: objects.length > 0, maxBytes, maxEntries
            });
        } catch (error) {
            if (signal.aborted) return;
            console.error("Failed to list folder for download:", error.name);
            return res.status(502).send({ error: "Could not calculate the folder size. Try again." });
        }
    });

    app.get("/folder-download/file", async (req, res) => {
        const { key, etag, size } = req.query;
        if (!isArchivePath(key) || !isObjectETag(etag) || typeof size !== "string" ||
            !/^\d+$/.test(size) || Number(size) > maxBytes) {
            return res.status(400).send({ error: "Valid file metadata is required" });
        }

        const expectedSize = Number(size);
        const signal = abortOnClose(res);
        let object;
        try {
            object = await s3.send(new GetObjectCommand({
                Bucket: bucket,
                Key: key,
                IfMatch: etag
            }), { abortSignal: signal });
        } catch (error) {
            if (signal.aborted) return;
            const status = error.$metadata?.httpStatusCode;
            if (status === 404 || status === 412) {
                return res.status(409).send({ error: "A file changed or was removed. Reopen the download to check the folder again." });
            }
            console.error("Failed to fetch file for folder download:", error.name);
            return res.status(502).send({ error: "Could not retrieve a file from R2. Try again." });
        }

        if (object.ContentLength !== expectedSize || !object.Body) {
            object.Body?.destroy();
            return res.status(409).send({ error: "A file changed. Reopen the download to check the folder again." });
        }

        res.set({
            "Cache-Control": "no-store, no-transform",
            "Content-Length": String(expectedSize),
            "Content-Type": "application/octet-stream",
            "Content-Disposition": "attachment",
            "X-Content-Type-Options": "nosniff"
        });
        try {
            await pipeline(object.Body, res, { signal });
        } catch (error) {
            if (!signal.aborted) console.error("Folder download stream failed:", error.name);
        }
    });
};
