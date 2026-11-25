const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test } = require("node:test");
const express = require("express");
const { DeleteObjectsCommand, S3Client } = require("@aws-sdk/client-s3");

test("file deletion preserves root keys and treats a literal star as a file name", async (t) => {
    const listen = t.mock.method(express.application, "listen", () => {});
    const app = require("../index");
    listen.mock.restore();

    const deletedKeys = [];
    t.mock.method(S3Client.prototype, "send", async (command) => {
        assert.ok(command instanceof DeleteObjectsCommand);
        const objects = command.input.Delete.Objects;
        deletedKeys.push(...objects.map(({ Key }) => Key));
        return { Deleted: objects };
    });

    const server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/delete-file`;

    for (const body of [
        { folder: "", fileNames: ["root.txt", "*"] },
        { folder: "photos", fileNames: ["*"] }
    ]) {
        const response = await fetch(url, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        assert.equal(response.status, 200);
        await response.json();
    }

    assert.deepEqual(deletedKeys, ["root.txt", "*", "photos/*"]);
});
