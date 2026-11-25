(() => {
    const dialog = document.getElementById("folder-download-dialog");
    const name = document.getElementById("folder-download-name");
    const summary = document.getElementById("folder-download-summary");
    const progress = document.getElementById("folder-download-progress");
    const status = document.getElementById("folder-download-status");
    const confirmButton = document.getElementById("folder-download-confirm");
    const cancelButton = document.getElementById("folder-download-cancel");
    let session;

    function bytesLabel(bytes) {
        const exact = `${bytes.toLocaleString()} bytes`;
        let size = Number(bytes);
        if (size < 1024) return exact;
        const units = ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
        let unit = -1;
        do {
            size /= 1024;
            unit++;
        } while (size >= 1024 && unit < units.length - 1);
        return `${size.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[unit]} (${exact})`;
    }

    async function request(url, signal) {
        const response = await fetch(url, { signal });
        if (!response.ok) {
            const { error } = await response.json().catch(() => ({}));
            throw new Error(error || "The download request failed. Try again.");
        }
        return response;
    }

    async function loadManifest(folder, signal) {
        let entries = new Map();
        let totalBytes = 0n;
        let fileCount = 0;
        let entryCount = 0;
        let found = false;
        let cursor = null;
        const seenCursors = new Set();
        do {
            const query = new URLSearchParams({ folder });
            if (cursor) query.set("cursor", cursor);
            const response = await request(`/folder-download/manifest?${query}`, signal);
            const page = await response.json();
            signal.throwIfAborted();
            found ||= page.found;

            for (const entry of page.entries) {
                const archivePath = entry.directory ? `${entry.path}/` : entry.path;
                if (entries?.has(archivePath)) continue;
                entryCount++;
                if (!entry.directory) {
                    totalBytes += BigInt(entry.size);
                    fileCount++;
                }
                if (totalBytes > BigInt(page.maxBytes) || entryCount >= page.maxEntries) {
                    entries = null;
                } else {
                    entries.set(archivePath, entry);
                }
            }

            cursor = page.nextCursor;
            if (cursor) {
                if (seenCursors.has(cursor)) throw new Error("R2 repeated a folder cursor. Try again.");
                seenCursors.add(cursor);
            }
            summary.textContent = `Calculating size… ${fileCount.toLocaleString()} files counted`;

            if (!cursor) {
                if (!found) throw new Error("The folder no longer exists.");
                const limit = `${page.maxBytes / (1024 * 1024)} MiB of original data and ${page.maxEntries.toLocaleString()} ZIP entries`;
                if (entries) {
                    for (const { path, directory } of entries.values()) {
                        let parent = directory ? path : path.substring(0, path.lastIndexOf("/"));
                        while (parent) {
                            if (entries.has(parent)) {
                                throw new Error("The folder contains a file and a subfolder with the same path.");
                            }
                            parent = parent.substring(0, parent.lastIndexOf("/"));
                        }
                    }
                }
                return { entries: entries ? Array.from(entries.values()) : null, totalBytes, fileCount, limit };
            }
        } while (cursor);
    }

    function closeDialog() {
        session?.controller.abort();
        session = null;
        dialog.close();
    }

    window.openFolderDownload = async (folder) => {
        if (dialog.open) return;
        const current = { folder, controller: new AbortController(), manifest: null };
        session = current;
        name.textContent = folder;
        summary.textContent = "Calculating size…";
        status.textContent = "";
        progress.hidden = true;
        confirmButton.disabled = true;
        cancelButton.textContent = "Cancel";
        dialog.showModal();

        try {
            const manifest = await loadManifest(folder, current.controller.signal);
            current.controller.signal.throwIfAborted();
            current.manifest = manifest;
            const fileLabel = manifest.fileCount === 1 ? "file" : "files";
            summary.textContent = `${manifest.fileCount.toLocaleString()} ${fileLabel} · ${bytesLabel(manifest.totalBytes)} before compression`;
            if (manifest.entries) {
                status.textContent = "The files will be downloaded into memory and compressed in your browser.";
                confirmButton.disabled = false;
            } else {
                status.textContent = `This folder exceeds the browser ZIP limit of ${manifest.limit}. Download smaller subfolders or individual files.`;
                cancelButton.textContent = "Close";
            }
        } catch (error) {
            if (current.controller.signal.aborted) return;
            summary.textContent = "Folder size unavailable";
            status.textContent = error.message;
            cancelButton.textContent = "Close";
        }
    };

    async function downloadFiles(folder, manifest, signal) {
        const files = manifest.entries.filter(entry => !entry.directory);
        let index = 0;
        let completed = 0;
        let received = 0;
        status.textContent = `Downloading 0 of ${files.length.toLocaleString()} files…`;

        await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
            while (index < files.length) {
                signal.throwIfAborted();
                const entry = files[index++];
                const query = new URLSearchParams({
                    key: `${folder}/${entry.path}`, etag: entry.etag, size: entry.size
                });
                const response = await request(`/folder-download/file?${query}`, signal);
                entry.data = await response.arrayBuffer();
                if (entry.data.byteLength !== entry.size) {
                    throw new Error("A file was incomplete. Reopen the download to try again.");
                }
                signal.throwIfAborted();
                completed++;
                received += entry.size;
                progress.value = completed / files.length * 100;
                status.textContent = `Downloaded ${completed.toLocaleString()} of ${files.length.toLocaleString()} files (${bytesLabel(received)})…`;
            }
        }));
    }

    async function compress(folderName, entries, signal) {
        const worker = new Worker("/folder-download/zip-worker.js");
        let onAbort;
        try {
            return await new Promise((resolve, reject) => {
                onAbort = () => reject(signal.reason);
                signal.addEventListener("abort", onAbort, { once: true });
                worker.onmessage = ({ data }) => {
                    if (data.error) reject(new Error(data.error));
                    else if (data.zip) resolve(data.zip);
                    else progress.value = data.progress;
                };
                worker.onerror = () => reject(new Error("Could not start ZIP compression."));
                const transfer = entries.filter(entry => !entry.directory).map(entry => entry.data);
                worker.postMessage({ folderName, entries }, transfer);
            });
        } finally {
            signal.removeEventListener("abort", onAbort);
            worker.terminate();
        }
    }

    confirmButton.onclick = async () => {
        const current = session;
        if (!current?.manifest?.entries || confirmButton.disabled) return;
        const { folder, manifest, controller } = current;
        const signal = controller.signal;
        confirmButton.disabled = true;
        progress.value = 0;
        progress.hidden = false;
        try {
            await downloadFiles(folder, manifest, signal);
            signal.throwIfAborted();
            status.textContent = "Compressing ZIP in your browser…";
            progress.value = 0;
            const folderName = folder.split("/").pop();
            const blob = await compress(folderName, manifest.entries, signal);
            signal.throwIfAborted();
            const link = document.createElement("a");
            const url = URL.createObjectURL(blob);
            link.href = url;
            link.download = `${folderName}.zip`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            closeDialog();
            showToast("ZIP ready. Check your browser downloads.");
        } catch (error) {
            if (signal.aborted) return;
            controller.abort();
            current.manifest = null;
            progress.hidden = true;
            status.textContent = error.message;
            cancelButton.textContent = "Close";
        }
    };

    cancelButton.onclick = closeDialog;
    dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        closeDialog();
    });
})();
