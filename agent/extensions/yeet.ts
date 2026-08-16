import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const YEET_PROMPT = `Commit and push the current repository changes.

Steps:
1. Add all unstaged changes with \`git add -A\`.
2. Inspect the staged changes and write a concise commit message that accurately summarizes them.
3. Show the proposed commit message to the user and stop. Do not commit or push yet.
4. Wait for the user to explicitly accept the proposed message or provide an edited replacement.
5. Only after that approval, commit using the exact accepted or edited message.
6. Push the commit to the current branch's remote.
   - If the current branch does not have an upstream remote branch, create one by pushing with upstream tracking.
   - If this repository has no git remotes configured, do not push.
7. After pushing, output the remote URL for what was pushed if the repository has a remote.
   - If the current branch is \`main\` or \`master\`, output the normal remote repository URL.
   - Otherwise, output a URL to create a pull request from the pushed branch into the repository's primary branch (\`main\` if it exists, otherwise \`master\`).
   - Convert SSH git remotes like \`git@github.com:owner/repo.git\` to HTTPS URLs when printing.

Keep the commit message concise. User approval is mandatory: never combine the proposal and commit into the same turn.`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("yeet", {
    description: "Stage changes, approve or edit the commit message, then commit and push",
    handler: async (args, ctx) => {
      const prompt = args?.trim()
        ? `${YEET_PROMPT}\n\nAdditional instructions from the user:\n${args.trim()}`
        : YEET_PROMPT;

      if (ctx.isIdle()) {
        pi.sendUserMessage(prompt);
      } else {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /yeet as a follow-up", "info");
      }
    },
  });
}
