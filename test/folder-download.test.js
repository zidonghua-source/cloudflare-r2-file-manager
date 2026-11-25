const assert = require("node:assert/strict");
const { once } = require("node:events");
const { Readable } = require("node:stream");
const { before, after, test } = require("node:test");
const express = require("express");
const { GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const registerFolderDownloads = require("../folder-download");

const storage = { send: async () => assert.fail("Unexpected R2 request") };
const app = express();
registerFolderDownloads(app, storage, "test-bucket");

let server;
let baseUrl;
before(async () => {
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${server.address().port}/folder-download`;
});
after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

const etag = '"0123456789abcdef-2"';
function manifest(query) {
    return fetch(`${baseUrl}/manifest?${new URLSearchParams(query)}`);
}

test("returns recursive file sizes and empty directory markers without fetching file content", async (t) => {
    const folder = "dự án";
    const token = "+/page=&";
    t.mock.method(storage, "send", async (command) => {
        assert.ok(command instanceof ListObjectsV2Command);
        assert.equal(command.input.Bucket, "test-bucket");
        assert.equal(command.input.Prefix, `${folder}/`);
        assert.equal(command.input.Delimiter, undefined);
        if (command.input.ContinuationToken === undefined) {
            return {
                IsTruncated: true,
                NextContinuationToken: token,
                Contents: [
                    { Key: `${folder}/` },
                    { Key: `${folder}/.placeholder` },
                    { Key: `${folder}/empty/.placeholder` },
                    { Key: `${folder}/empty/` },
                    { Key: `${folder}/ảnh/cat.png`, Size: 120, ETag: etag }
                ]
            };
        }
        assert.equal(command.input.ContinuationToken, token);
        return { Contents: [{ Key: `${folder}/zero.txt`, Size: 0, ETag: etag }] };
    });

    const first = await manifest({ folder });
    assert.equal(first.status, 200);
    const firstPage = await first.json();
    assert.deepEqual(firstPage.entries, [
        { path: "empty", directory: true },
        { path: "empty", directory: true },
        { path: "ảnh/cat.png", size: 120, etag }
    ]);
    assert.equal(firstPage.nextCursor, token);
    assert.equal(firstPage.found, true);
    const last = await manifest({ folder, cursor: token });
    const lastPage = await last.json();
    assert.deepEqual(lastPage.entries, [{ path: "zero.txt", size: 0, etag }]);
    assert.equal(lastPage.nextCursor, null);
});

test("rejects unsafe ZIP paths and malformed stream parameters", async (t) => {
    assert.equal((await manifest({ folder: "photos/.." })).status, 400);
    const malformed = await fetch(`${baseUrl}/file?key=photos/file&etag=%220abc%22&size%5BtoString%5D=10`);
    assert.equal(malformed.status, 400);

    t.mock.method(storage, "send", async () => ({ Contents: [{ Key: "photos/../file" }] }));
    const response = await manifest({ folder: "photos" });
    assert.equal(response.status, 409);
});

test("streams the original bytes with an R2 If-Match condition", async (t) => {
    const original = Buffer.from([0x00, 0x01, 0xff]);
    const key = "dự án/a & b.bin";
    t.mock.method(storage, "send", async (command) => {
        assert.ok(command instanceof GetObjectCommand);
        assert.deepEqual(command.input, { Bucket: "test-bucket", Key: key, IfMatch: etag });
        return { Body: Readable.from([original]), ContentLength: original.length };
    });

    const response = await fetch(`${baseUrl}/file?${new URLSearchParams({ key, etag, size: original.length })}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
});

test("reports replaced files rather than returning a partial ZIP input", async (t) => {
    t.mock.method(storage, "send", async () => {
        throw Object.assign(new Error("PreconditionFailed"), { $metadata: { httpStatusCode: 412 } });
    });
    const response = await fetch(`${baseUrl}/file?${new URLSearchParams({ key: "folder/file", etag, size: 1 })}`);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /changed or was removed/);
});
