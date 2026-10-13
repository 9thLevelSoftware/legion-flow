import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { MapFactsSchema } from "@9thlevelsoftware/legion-flow-schema";
import { extractMap, factsSha256, nextRouteOf, MAP_EXTRACTOR_VERSION } from "../dist/index.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function tree(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "legion-flow-routes-"));
  const inputs: { path: string; sha256: string }[] = [];
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
    inputs.push({ path, sha256: sha(body) });
  }
  return { root, inputs: inputs.sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

const FILES = {
  "src/server.ts": [
    'import express from "express";',
    "const app = express();",
    "const router = express.Router();",
    'app.get("/users", (req, res) => res.send([]));',
    "router.post(`/users/:id`, handler);",
    'app.all("/health", h);',
    'app.get("env", h);',
    'app.set("x", 1);',
    'const base = "/v1";',
    "app.get(`${base}/items`, (req, res) => {});",
    'app.get(base + "/x", opts);',
    "const map = new Map();",
    'map.get("/users");',
    'client.get("/users", () => 1);',
    'fastify.route({ method: ["GET", "POST"], url: "/f", handler: h });',
    'fastify.route({ method: dyn, url: "/g" });',
    "",
  ].join("\n"),
  "app/api/items/[id]/route.ts": "export async function GET() {}\nexport const POST = async () => {};\nexport function helper() {}\n",
  "app/(shop)/api/cart/route.ts": "export function DELETE() {}\n",
  "pages/api/hello.ts": "export default function handler() {}\n",
  "pages/api/index.ts": "export default function handler() {}\n",
  "pages/about.ts": "export default function About() {}\n",
};

describe("M4 slice (g): HTTP route facts by syntax", () => {
  test("Express-style calls on listed receivers, fastify.route, Next.js app and pages/api; non-literal paths unresolved; lookalikes left out; deterministic", async () => {
    const { root, inputs } = await tree(FILES);
    try {
      const a = extractMap(root, inputs);
      MapFactsSchema.parse(a.facts);
      assert.match(MAP_EXTRACTOR_VERSION, /^legion-flow-map\/3 /);
      const got = a.facts.routes.map((r) => `${r.method} ${r.path ?? `?${r.unresolved}`} ${r.module} ${r.detector}`);
      assert.deepEqual(got, [
        "delete /api/cart app/(shop)/api/cart/route.ts next_app",
        "get /api/items/[id] app/api/items/[id]/route.ts next_app",
        "post /api/items/[id] app/api/items/[id]/route.ts next_app",
        "any /api/hello pages/api/hello.ts next_pages",
        "any /api pages/api/index.ts next_pages",
        "all /health src/server.ts express_call",
        "any /g src/server.ts fastify_route",
        "get /f src/server.ts fastify_route",
        "get /users src/server.ts express_call",
        "get ?`${base}/items` src/server.ts express_call",
        "post /f src/server.ts fastify_route",
        "post /users/:id src/server.ts express_call",
      ]);
      const users = a.facts.routes.find((r) => r.path === "/users")!;
      assert.equal(users.line, 4);
      assert.ok(!got.some((g) => g.includes("env")), "app.get(name) with a non-path literal is a settings read, not a route");
      assert.ok(!got.some((g) => g.includes("base +")), "a non-literal path with no handler function after it is left out");
      assert.equal(got.filter((g) => g.includes("/users ")).length, 1, "Map.get and an unlisted receiver are not routes");
      const b = extractMap(root, inputs);
      assert.equal(factsSha256(b.facts), factsSha256(a.facts), "the same tree yields the same facts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Next.js paths: route groups and parallel slots drop out, dynamic segments stay literal, pages/api index is the directory", () => {
    assert.deepEqual(nextRouteOf("src/app/(marketing)/@modal/blog/[slug]/route.ts"), { detector: "next_app", path: "/blog/[slug]" });
    assert.deepEqual(nextRouteOf("app/route.js"), { detector: "next_app", path: "/" });
    assert.deepEqual(nextRouteOf("pages/api/users/index.ts"), { detector: "next_pages", path: "/api/users" });
    assert.equal(nextRouteOf("app/page.tsx"), null);
    assert.equal(nextRouteOf("pages/about.ts"), null);
  });
});
