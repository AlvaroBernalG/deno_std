#!/usr/bin/env deno --allow-net
// Copyright 2018-2019 the Deno authors. All rights reserved. MIT license.

// This program serves files in the current directory over HTTP.
// TODO Stream responses instead of reading them into memory.
// TODO Add tests like these:
// https://github.com/indexzero/http-server/blob/master/test/http-server-test.js

const { ErrorKind, cwd, args, stat, readDir, open } = Deno;
import {
  listenAndServe,
  ServerRequest,
  setContentLength,
  Response
} from "./server.ts";
import { extname } from "../fs/path.ts";
import { contentType } from "../media_types/mod.ts";

const dirViewerTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="ie=edge">
  <title>Deno File Server</title>
  <style>
    td {
      padding: 0 1rem;
    }
    td.mode {
      font-family: Courier;
    }
  </style>
</head>
<body>
  <h1>Index of <%DIRNAME%></h1>
  <table>
    <tr><th>Mode</th><th>Size</th><th>Name</th></tr>
    <%CONTENTS%>
  </table>
</body>
</html>
`;

const serverArgs = args.slice();
let CORSEnabled = false;
// TODO: switch to flags if we later want to add more options
for (let i = 0; i < serverArgs.length; i++) {
  if (serverArgs[i] === "--cors") {
    CORSEnabled = true;
    serverArgs.splice(i, 1);
    break;
  }
}
let currentDir = cwd();
const target = serverArgs[1];
if (target) {
  currentDir = `${currentDir}/${target}`;
}
const addr = `0.0.0.0:${serverArgs[2] || 4500}`;
const encoder = new TextEncoder();

function modeToString(isDir: boolean, maybeMode: number | null): string {
  const modeMap = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];

  if (maybeMode === null) {
    return "(unknown mode)";
  }
  const mode = maybeMode!.toString(8);
  if (mode.length < 3) {
    return "(unknown mode)";
  }
  let output = "";
  mode
    .split("")
    .reverse()
    .slice(0, 3)
    .forEach(
      (v): void => {
        output = modeMap[+v] + output;
      }
    );
  output = `(${isDir ? "d" : "-"}${output})`;
  return output;
}

function fileLenToString(len: number): string {
  const multipler = 1024;
  let base = 1;
  const suffix = ["B", "K", "M", "G", "T"];
  let suffixIndex = 0;

  while (base * multipler < len) {
    if (suffixIndex >= suffix.length - 1) {
      break;
    }
    base *= multipler;
    suffixIndex++;
  }

  return `${(len / base).toFixed(2)}${suffix[suffixIndex]}`;
}

function createDirEntryDisplay(
  name: string,
  path: string,
  size: number | null,
  mode: number | null,
  isDir: boolean
): string {
  const sizeStr = size === null ? "" : "" + fileLenToString(size!);
  return `
  <tr><td class="mode">${modeToString(
    isDir,
    mode
  )}</td><td>${sizeStr}</td><td><a href="${path}">${name}${
    isDir ? "/" : ""
  }</a></td>
  </tr>
  `;
}

async function serveFile(
  req: ServerRequest,
  filename: string
): Promise<Response> {
  const file = await open(filename);
  const fileInfo = await stat(filename);
  const headers = new Headers();
  headers.set("content-length", fileInfo.len.toString());
  headers.set("content-type", contentType(extname(filename)) || "text/plain");

  const res = {
    status: 200,
    body: file,
    headers
  };
  return res;
}

// TODO: simplify this after deno.stat and deno.readDir are fixed
async function serveDir(
  req: ServerRequest,
  dirPath: string,
  dirName: string
): Promise<Response> {
  // dirname has no prefix
  const listEntry: string[] = [];
  const fileInfos = await readDir(dirPath);
  for (const info of fileInfos) {
    if (info.name === "index.html" && info.isFile()) {
      // in case index.html as dir...
      return await serveFile(req, info.path);
    }
    // Yuck!
    let mode = null;
    try {
      mode = (await stat(info.path)).mode;
    } catch (e) {}
    listEntry.push(
      createDirEntryDisplay(
        info.name,
        dirName + "/" + info.name,
        info.isFile() ? info.len : null,
        mode,
        info.isDirectory()
      )
    );
  }

  const page = new TextEncoder().encode(
    dirViewerTemplate
      .replace("<%DIRNAME%>", dirName + "/")
      .replace("<%CONTENTS%>", listEntry.join(""))
  );

  const headers = new Headers();
  headers.set("content-type", "text/html");

  const res = {
    status: 200,
    body: page,
    headers
  };
  setContentLength(res);
  return res;
}

async function serveFallback(req: ServerRequest, e: Error): Promise<Response> {
  if (
    e instanceof Deno.DenoError &&
    (e as Deno.DenoError<Deno.ErrorKind.NotFound>).kind === ErrorKind.NotFound
  ) {
    return {
      status: 404,
      body: encoder.encode("Not found")
    };
  } else {
    return {
      status: 500,
      body: encoder.encode("Internal server error")
    };
  }
}

function serverLog(req: ServerRequest, res: Response): void {
  const d = new Date().toISOString();
  const dateFmt = `[${d.slice(0, 10)} ${d.slice(11, 19)}]`;
  const s = `${dateFmt} "${req.method} ${req.url} ${req.proto}" ${res.status}`;
  console.log(s);
}

function setCORS(res: Response): void {
  if (!res.headers) {
    res.headers = new Headers();
  }
  res.headers!.append("access-control-allow-origin", "*");
  res.headers!.append(
    "access-control-allow-headers",
    "Origin, X-Requested-With, Content-Type, Accept, Range"
  );
}

listenAndServe(
  addr,
  async (req): Promise<void> => {
    const fileName = req.url.replace(/\/$/, "");
    const filePath = currentDir + fileName;

    let response: Response;

    try {
      const fileInfo = await stat(filePath);
      if (fileInfo.isDirectory()) {
        // Bug with deno.stat: name and path not populated
        // Yuck!
        response = await serveDir(req, filePath, fileName);
      } else {
        response = await serveFile(req, filePath);
      }
    } catch (e) {
      response = await serveFallback(req, e);
    } finally {
      if (CORSEnabled) {
        setCORS(response);
      }
      serverLog(req, response);
      req.respond(response);
    }
  }
);

console.log(`HTTP server listening on http://${addr}/`);
