import { NextRequest, NextResponse } from "next/server";

const owner = process.env.GITHUB_OWNER!;
const repo = process.env.GITHUB_REPO!;
const workflowFile = process.env.WORKFLOW_FILE || "deploy.yml";
const pat = process.env.GITHUB_PAT!;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { env?: "preview" | "production" };
    const env = body.env || "preview";

    if (!owner || !repo || !pat) {
      return NextResponse.json(
        { ok: false, error: "Missing GITHUB_* env vars on server" },
        { status: 500 }
      );
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { env },
      }),
      // GitHub requires no cache
      cache: "no-store",
    });

    if (res.status !== 204) {
      const txt = await res.text();
      return NextResponse.json(
        { ok: false, error: `GitHub API error (${res.status}): ${txt}` },
        { status: 500 }
      );
    }

    // A 204 means the workflow was successfully queued.
    const actionsUrl = `https://github.com/${owner}/${repo}/actions/workflows/${workflowFile}`;
    return NextResponse.json({ ok: true, message: "Deploy triggered", actionsUrl, env });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unknown error" }, { status: 500 });
  }
}
