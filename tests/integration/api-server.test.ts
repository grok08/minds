import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHmac } from "crypto";

const SERVER_URL = "http://localhost:3000";
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

describe("API Server", () => {
  test("GET /health", async () => {
    const response = await fetch(`${SERVER_URL}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
  });

  test("GET /minds", async () => {
    const response = await fetch(`${SERVER_URL}/minds`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  test("GET /tasks", async () => {
    const response = await fetch(`${SERVER_URL}/tasks`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("POST /events - invalid signature rejected", async () => {
    const response = await fetch(`${SERVER_URL}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "workflow_run",
        "X-Hub-Signature-256": "sha256=invalid"
      },
      body: JSON.stringify({ action: "completed" })
    });
    expect(response.status).toBe(401);
  });

  test("POST /events - verifies signature against the exact raw body", async () => {
    if (!WEBHOOK_SECRET) {
      throw new Error("GITHUB_WEBHOOK_SECRET is required for this test");
    }
    const rawPayload = '{ "action" : "ping" }';
    const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawPayload).digest("hex")}`;
    const response = await fetch(`${SERVER_URL}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-Hub-Signature-256": signature,
      },
      body: rawPayload,
    });

    expect(response.status).toBe(202);
  });

  test("POST /events - missing x-github-event returns 202", async () => {
    const response = await fetch(`${SERVER_URL}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "completed" })
    });
    expect(response.status).toBe(202);
  });
});