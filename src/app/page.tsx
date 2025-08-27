"use client";

import { useState } from "react";

export default function Home() {
  const [loading, setLoading] = useState<"preview" | "production" | "fork" | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [mySecret, setMySecret] = useState<string>("");

  async function trigger(env: "preview" | "production") {
    setLoading(env);
    setMsg("");
    try {
      const res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env }),
      });
      const data = await res.json();
      if (data.ok) {
        setMsg(`✅ ${env} deploy queued with MY_SECRET. Check: ${data.actionsUrl}`);
      } else {
        setMsg(`❌ ${data.error}`);
      }
    } catch {
      setMsg("⚠️ Failed to hit /api/deploy");
    } finally {
      setLoading(null);
    }
  }

  async function createForkAndDeploy() {
    if (!mySecret.trim()) {
      setMsg("❌ Please enter a secret value");
      return;
    }

    setLoading("fork");
    setMsg("");
    try {
      const res = await fetch("/api/fork-and-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: mySecret.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setMsg(`✅ Repository created and deployed! Repo: ${data.repoName}\n🔗 Preview URL: ${data.previewUrl}\n📝 GitHub: ${data.repoUrl}`);
      } else {
        setMsg(`❌ ${data.error}`);
      }
    } catch {
      setMsg("⚠️ Failed to create repository and deploy");
    } finally {
      setLoading(null);
    }
  }

  return (
    <main className="min-h-screen grid place-items-center p-8">
      <div className="max-w-xl w-full space-y-4">
        <h1 className="text-2xl font-semibold">Cloudflare Deploy Demo</h1>
        <p className="text-sm text-gray-500">
          Create a unique fork and deploy it to Cloudflare with your secret, or deploy existing repo.
        </p>

        {/* Fork and Deploy Section */}
        <div className="border-2 border-green-200 bg-green-50 p-4 rounded-lg space-y-4">
          <h3 className="font-semibold text-green-800">🚀 Create New Repo & Deploy</h3>
          <p className="text-sm text-green-700">
            Enter a secret to create a uniquely named repository and deploy it to Cloudflare.
          </p>
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Enter your secret (e.g., mycompany-2024)"
              value={mySecret}
              onChange={(e) => setMySecret(e.target.value)}
              className="w-full px-3 py-2 border border-green-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <button
              onClick={createForkAndDeploy}
              disabled={!!loading || !mySecret.trim()}
              className="w-full px-4 py-2 rounded-lg shadow bg-green-600 text-white disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {loading === "fork" ? "Creating repository and deploying..." : "Create New Repo & Deploy"}
            </button>
          </div>
        </div>

        {/* Existing Deploy Section */}
        <div className="border-2 border-blue-200 bg-blue-50 p-4 rounded-lg space-y-4">
          <h3 className="font-semibold text-blue-800">📦 Deploy Existing Repo</h3>
          <p className="text-sm text-blue-700">
            Deploy the current repository to different environments.
          </p>
          <div className="flex gap-3">
          <button
            onClick={() => trigger("preview")}
            disabled={!!loading}
            className="px-4 py-2 rounded-xl shadow bg-blue-600 text-white"
          >
            {loading === "preview" ? "Deploying preview…" : "Deploy Preview"}
          </button>

          <button
            onClick={() => trigger("production")}
            disabled={!!loading}
            className="px-4 py-2 rounded-xl shadow bg-green-600 text-white"
          >
            {loading === "production" ? "Deploying production…" : "Deploy Production"}
          </button>
        </div>
        </div>

        {!!msg && <pre className="text-sm p-3 bg-gray-900/90 text-gray-50 rounded-lg whitespace-pre-wrap">{msg}</pre>}
      </div>
    </main>
  );
}
