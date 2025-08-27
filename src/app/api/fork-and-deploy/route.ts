import { NextRequest, NextResponse } from "next/server";
import sodium from "libsodium-wrappers";

const githubToken = process.env.GITHUB_PAT!;
const originalOwner = process.env.GITHUB_OWNER!;
const originalRepo = process.env.GITHUB_REPO!;
const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN!;
const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID!;

export async function POST(req: NextRequest) {
  try {
    const { secret } = await req.json();
    
    if (!secret || !secret.trim()) {
      return NextResponse.json(
        { ok: false, error: "Secret is required" },
        { status: 400 }
      );
    }

    if (!githubToken || !originalOwner || !originalRepo) {
      return NextResponse.json(
        { ok: false, error: "Missing GitHub configuration" },
        { status: 500 }
      );
    }

    if (!cloudflareToken || !cloudflareAccountId) {
      return NextResponse.json(
        { ok: false, error: "Missing Cloudflare configuration" },
        { status: 500 }
      );
    }

    // Clean the secret for use in repo name
    const cleanSecret = secret.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const newRepoName = `${originalRepo}-${cleanSecret}`;
    
    console.log(`Creating fork: ${newRepoName}`);

// Step 1: Fork the original repository
const forkResponse = await fetch(`https://api.github.com/repos/${originalOwner}/${originalRepo}/forks`, {
    method: "POST", 
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      name: newRepoName,
      default_branch_only: true,
    }),
  });
  
  if (!forkResponse.ok) {
    const errorText = await forkResponse.text();
    return NextResponse.json(
      { ok: false, error: `Failed to fork repository: ${errorText}` },
      { status: 500 }
    );
  }
  
  const repoData = await forkResponse.json();
  const newOwner = repoData.owner.login;
  
  console.log(`Repository forked: ${newOwner}/${newRepoName}`);

    // Wait for repository to be fully initialized
    console.log('Waiting for fork to be ready...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 2: Update wrangler.toml in the forked repo
    const updateResponse = await updateWranglerConfig(newOwner, newRepoName, secret, cleanSecret);
    if (!updateResponse.ok) {
      return updateResponse;
    }

    // Step 3: Set up GitHub secrets in the forked repo
    const secretsResponse = await setupGitHubSecrets(newOwner, newRepoName);
    if (!secretsResponse.ok) {
      return secretsResponse;
    }

    // Step 4: Trigger deployment
    const deployResponse = await triggerDeployment(newOwner, newRepoName);
    if (!deployResponse.ok) {
      return deployResponse;
    }

    // Step 5: Generate preview URL
    const previewUrl = `https://${originalRepo}-${cleanSecret}-preview.${newOwner}.workers.dev`;
    
    return NextResponse.json({
      ok: true,
      repoName: newRepoName,
      repoUrl: `https://github.com/${newOwner}/${newRepoName}`,
      previewUrl,
      message: "Repository forked and deployment triggered successfully!"
    });

  } catch (error: any) {
    console.error("Fork and deploy error:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Unknown error occurred" },
      { status: 500 }
    );
  }
}

async function updateWranglerConfig(owner: string, repo: string, secret: string, cleanSecret: string) {
  try {
    // Get current wrangler.toml file
    const getFileResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/workers/hello/wrangler.toml`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!getFileResponse.ok) {
      throw new Error("Failed to get wrangler.toml");
    }

    const fileData = await getFileResponse.json();
    const currentContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
    
    // Update the content with new worker names and secret
    const updatedContent = currentContent
      .replace(/name = "cf-demo-worker"/g, `name = "cf-demo-worker-${cleanSecret}"`)
      .replace(/name = "cf-demo-worker-preview"/g, `name = "cf-demo-worker-${cleanSecret}-preview"`)
      .replace(/MY_SECRET = "dev-secret"/g, `MY_SECRET = "${secret}"`)
      .replace(/MY_SECRET = "preview-secret"/g, `MY_SECRET = "${secret}"`)
      .replace(/MY_SECRET = "production-secret"/g, `MY_SECRET = "${secret}"`);

    // Update the file
    const updateFileResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/workers/hello/wrangler.toml`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        message: `Update wrangler.toml with secret: ${cleanSecret}`,
        content: Buffer.from(updatedContent).toString('base64'),
        sha: fileData.sha,
      }),
    });

    if (!updateFileResponse.ok) {
      const errorText = await updateFileResponse.text();
      throw new Error(`Failed to update wrangler.toml: ${errorText}`);
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: `Failed to update wrangler config: ${error.message}` },
      { status: 500 }
    );
  }
}

async function setupGitHubSecrets(owner: string, repo: string) {
  try {
    // Get the repository's public key for encrypting secrets
    const keyResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!keyResponse.ok) {
      throw new Error("Failed to get repository public key");
    }

    const { key, key_id } = await keyResponse.json();
    
    // Properly encrypt secrets using GitHub's public key
    const secrets = [
      { name: "CLOUDFLARE_API_TOKEN", value: cloudflareToken },
      { name: "CLOUDFLARE_ACCOUNT_ID", value: cloudflareAccountId },
    ];

    // Set each secret with proper encryption
    for (const secret of secrets) {
      const encryptedValue = await encryptSecret(secret.value, key);
      
      const secretResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/${secret.name}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          encrypted_value: encryptedValue,
          key_id,
        }),
      });

      if (!secretResponse.ok) {
        console.warn(`Failed to set secret ${secret.name}`);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: `Failed to setup GitHub secrets: ${error.message}` },
      { status: 500 }
    );
  }
}

async function triggerDeployment(owner: string, repo: string) {
  try {
    // First, check if the workflow file exists
    const workflowCheckResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/deploy.yml`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!workflowCheckResponse.ok) {
      throw new Error(`Workflow file does not exist in repository. Status: ${workflowCheckResponse.status}`);
    }

    console.log('Workflow file exists, triggering deployment...');

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/deploy.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { env: "preview" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to trigger deployment: ${errorText}`);
    }

    console.log('Deployment triggered successfully');
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('Deployment trigger error:', error);
    return NextResponse.json(
      { ok: false, error: `Failed to trigger deployment: ${error.message}` },
      { status: 500 }
    );
  }
}

async function encryptSecret(secret: string, publicKey: string): Promise<string> {
  // Ensure sodium is ready
  await sodium.ready;
  
  // Convert the public key from base64
  const keyBytes = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  
  // Convert secret to bytes
  const secretBytes = sodium.from_string(secret);
  
  // Encrypt using libsodium's crypto_box_seal (perfect for GitHub secrets)
  const encryptedBytes = sodium.crypto_box_seal(secretBytes, keyBytes);
  
  // Convert back to base64
  return sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
}