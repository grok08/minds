import { Octokit } from "@octokit/rest";

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
}

export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;

  constructor(config: GitHubConfig) {
    this.octokit = new Octokit({ auth: config.token });
    this.owner = config.owner;
    this.repo = config.repo;
  }

  async getWorkflowRun(runId: number) {
    const { data } = await this.octokit.actions.getWorkflowRun({
      owner: this.owner,
      repo: this.repo,
      run_id: runId,
    });
    return data;
  }

  async getWorkflowRunJobs(runId: number) {
    const { data } = await this.octokit.actions.listJobsForWorkflowRun({
      owner: this.owner,
      repo: this.repo,
      run_id: runId,
    });
    return data.jobs;
  }

  async getWorkflowRunLogs(runId: number) {
    const { data } = await this.octokit.actions.downloadWorkflowRunLogs({
      owner: this.owner,
      repo: this.repo,
      run_id: runId,
    });
    return data;
  }

  async getPullRequest(prNumber: number) {
    const { data } = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });
    return data;
  }

  async getPullRequestFiles(prNumber: number) {
    const { data } = await this.octokit.pulls.listFiles({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });
    return data;
  }

  async getPullRequestCommits(prNumber: number) {
    const { data } = await this.octokit.pulls.listCommits({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });
    return data;
  }

  async getRepository() {
    const { data } = await this.octokit.repos.get({
      owner: this.owner,
      repo: this.repo,
    });
    return data;
  }

  async createIssue(title: string, body: string) {
    const { data } = await this.octokit.issues.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
    });
    return data;
  }

  async createPullRequest(title: string, head: string, base: string, body: string) {
    const { data } = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title,
      head,
      base,
      body,
    });
    return data;
  }

  async getFileContent(path: string, ref?: string) {
    const { data } = await this.octokit.repos.getContent({
      owner: this.owner,
      repo: this.repo,
      path,
      ref,
    });
    return data;
  }

  async createOrUpdateFile(
    path: string,
    message: string,
    content: string,
    branch: string,
    sha?: string
  ) {
    const { data } = await this.octokit.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path,
      message,
      content: Buffer.from(content).toString("base64"),
      branch,
      sha,
    });
    return data;
  }

  async dispatchWorkflow(workflowFile: string, payload: { ref: string; inputs: Record<string, string> }): Promise<void> {
    await this.octokit.actions.createWorkflowDispatch({
      owner: this.owner,
      repo: this.repo,
      workflow_id: workflowFile,
      ref: payload.ref,
      inputs: payload.inputs,
    });
  }

  async cancelWorkflowRun(runId: number) {
    await this.octokit.actions.cancelWorkflowRun({
      owner: this.owner,
      repo: this.repo,
      run_id: runId,
    });
  }
}

export function createGitHubClient(config: GitHubConfig): GitHubClient {
  return new GitHubClient(config);
}