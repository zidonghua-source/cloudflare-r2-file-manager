importScripts("/folder-download/jszip.min.js");

self.onmessage = async ({ data: { folderName, entries } }) => {
    try {
        const zip = new JSZip();
        zip.file(`${folderName}/`, null, { dir: true, createFolders: false });
        for (const entry of entries) {
            const path = `${folderName}/${entry.path}`;
            if (entry.directory) {
                zip.file(`${path}/`, null, { dir: true, createFolders: false });
            } else {
                zip.file(path, entry.data, { createFolders: false });
            }
        }
        let previous;
        const blob = await zip.generateAsync({
            type: "blob",
            compression: "DEFLATE",
            compressionOptions: { level: 3 },
            streamFiles: true
        }, ({ percent }) => {
            const progress = Math.floor(percent);
            if (progress !== previous) {
                previous = progress;
                self.postMessage({ progress });
            }
        });
        self.postMessage({ zip: blob });
    } catch {
        self.postMessage({ error: "Could not compress the folder in this browser." });
    }
};
