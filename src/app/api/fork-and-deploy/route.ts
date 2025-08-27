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
    
    console.log(`Attempting to fork repository in organization: ${newRepoName}`);

    // Step 1: Try to fork first, fallback to create in organization if forking is disabled
    let repoData;
    let newOwner;
    let wasForked = false;

    try {
      // Try forking within the organization first
      const forkResponse = await fetch(`https://api.github.com/repos/${originalOwner}/${originalRepo}/forks`, {
        method: "POST", 
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          organization: originalOwner, // Fork within the same organization
          name: newRepoName,
          default_branch_only: true,
        }),
      });
      
      if (forkResponse.ok) {
        repoData = await forkResponse.json();
        newOwner = repoData.owner.login;
        wasForked = true;
        console.log(`Repository forked successfully in organization: ${newOwner}/${newRepoName}`);
      } else {
        const errorResponse = await forkResponse.json();
        
        // Check if forking is disabled
        if (forkResponse.status === 403 && errorResponse.message?.includes("forking is disabled")) {
          console.log('Forking is disabled, falling back to create repository in organization...');
          
          // Try creating in organization first
          let createResponse = await fetch(`https://api.github.com/orgs/${originalOwner}/repos`, {
            method: "POST", 
            headers: {
              Authorization: `Bearer ${githubToken}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({
              name: newRepoName,
              description: `Cloudflare Worker deployment with secret: ${secret}`,
              private: false,
              auto_init: true,
            }),
          });
          
          // If organization creation fails, fall back to personal account
          if (!createResponse.ok) {
            console.log('Failed to create in organization, trying personal account...');
            createResponse = await fetch("https://api.github.com/user/repos", {
              method: "POST", 
              headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
              body: JSON.stringify({
                name: newRepoName,
                description: `Cloudflare Worker deployment with secret: ${secret}`,
                private: false,
                auto_init: true,
              }),
            });
          }
          
          if (!createResponse.ok) {
            const errorText = await createResponse.text();
            throw new Error(`Failed to create repository: ${errorText}`);
          }
          
          repoData = await createResponse.json();
          newOwner = repoData.owner.login;
          console.log(`Repository created: ${newOwner}/${newRepoName}`);
          
          // Wait for repository initialization
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Copy repository content using Git API
          await copyRepositoryContent(originalOwner, originalRepo, newOwner, newRepoName);
          
        } else {
          throw new Error(`Failed to fork repository: ${JSON.stringify(errorResponse)}`);
        }
      }
    } catch (error: any) {
      throw new Error(`Repository creation failed: ${error.message}`);
    }

    // Wait for repository to be ready
    console.log('Waiting for repository to be ready...');
    await new Promise(resolve => setTimeout(resolve, wasForked ? 3000 : 2000));

    // Step 2: Enable GitHub Actions (if it was forked)
    if (wasForked) {
      const actionsResponse = await enableGitHubActions(originalOwner, newRepoName);
      if (!actionsResponse.ok) {
        console.warn('Failed to enable GitHub Actions, but continuing...');
      }
    }

    // Step 3: Update wrangler.toml in the new repo
    const updateResponse = await updateWranglerConfig(newOwner, newRepoName, secret, cleanSecret);
    if (!updateResponse.ok) {
      return updateResponse;
    }

    // Step 4: Set up GitHub secrets in the new repo
    const secretsResponse = await setupGitHubSecrets(newOwner, newRepoName);
    if (!secretsResponse.ok) {
      return secretsResponse;
    }

    // Step 5: Trigger deployment
    const deployResponse = await triggerDeployment(newOwner, newRepoName);
    if (!deployResponse.ok) {
      return deployResponse;
    }

    // Step 6: Generate preview URL
    const previewUrl = `https://${originalRepo}-${cleanSecret}-preview.${newOwner}.workers.dev`;
    
    return NextResponse.json({
      ok: true,
      repoName: newRepoName,
      repoUrl: `https://github.com/${newOwner}/${newRepoName}`,
      previewUrl,
      message: wasForked 
        ? "Repository forked and deployment triggered successfully!" 
        : "Repository created and deployment triggered successfully!"
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

async function enableGitHubActions(owner: string, repo: string) {
  try {
    console.log(`Enabling GitHub Actions for ${owner}/${repo}...`);

    // Step 1: Enable repo-level Actions
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/permissions`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        enabled: true,
        allowed_actions: "all",
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to enable Actions: ${err}`);
    }

    console.log("Actions enabled successfully at repo level");
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Error enabling GitHub Actions:", err);
    return NextResponse.json({ ok: false, error: err.message });
  }
}


// Efficient repository content copying using Git Trees API
async function copyRepositoryContent(sourceOwner: string, sourceRepo: string, targetOwner: string, targetRepo: string) {
  try {
    console.log('Copying repository content using Git Trees API...');
    
    // Get the source repository's main branch tree
    const sourceTreeResponse = await fetch(`https://api.github.com/repos/${sourceOwner}/${sourceRepo}/git/trees/main?recursive=1`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!sourceTreeResponse.ok) {
      throw new Error("Failed to get source repository tree");
    }

    const sourceTree = await sourceTreeResponse.json();
    
    // Get target repo's initial commit to get the parent
    const targetRefsResponse = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs/heads/main`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!targetRefsResponse.ok) {
      throw new Error("Failed to get target repository main branch");
    }

    const targetRef = await targetRefsResponse.json();
    const baseCommitSha = targetRef.object.sha;
    
    // Create new tree with all source files
    const createTreeResponse = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/trees`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        tree: sourceTree.tree.filter((item: any) => 
          item.type === "blob" && 
          !item.path.includes('.git/') &&
          !item.path.startsWith('node_modules/') &&
          item.path !== 'README.md' // Keep the auto-generated README
        ).map((item: any) => ({
          path: item.path,
          mode: item.mode,
          type: item.type,
          sha: item.sha
        }))
      }),
    });

    if (!createTreeResponse.ok) {
      const errorText = await createTreeResponse.text();
      throw new Error(`Failed to create tree: ${errorText}`);
    }

    const newTree = await createTreeResponse.json();
    
    // Create commit with the new tree
    const createCommitResponse = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/commits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        message: `Copy content from ${sourceOwner}/${sourceRepo}`,
        tree: newTree.sha,
        parents: [baseCommitSha],
      }),
    });

    if (!createCommitResponse.ok) {
      const errorText = await createCommitResponse.text();
      throw new Error(`Failed to create commit: ${errorText}`);
    }

    const newCommit = await createCommitResponse.json();
    
    // Update main branch to point to new commit
    const updateRefResponse = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs/heads/main`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        sha: newCommit.sha,
      }),
    });

    if (!updateRefResponse.ok) {
      const errorText = await updateRefResponse.text();
      throw new Error(`Failed to update main branch: ${errorText}`);
    }

    console.log('Repository content copied successfully using Git Trees API');
  } catch (error: any) {
    console.error('Error copying repository content:', error);
    throw error;
  }
}