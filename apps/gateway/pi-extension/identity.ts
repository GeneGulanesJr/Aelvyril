// Bundled pi extension: tells every thread who it is and what the app is.
// It uses pi's before_agent_start hook and pi's structured prompt options, never pi's own prompt wording,
// so updating pi does not break it. The gateway passes the names in the environment (Supervisor.identityEnv).
// Not part of the gateway's typecheck: pi supplies the types when it loads this file.

/** What the assistant knows about the app it lives in. The details are in the bundled guides (pi skills, apps/gateway/guides). */
const ABOUT =
  "About the app you live in: you are a personal AI assistant that runs on the person's own computer, and their chats, accounts and keys stay there. " +
  "Before you explain how something in the app works, or say what you can or cannot do, read the matching aelvyril guide from your skills; " +
  "call get_abilities to see what is connected and installed right now. Do not recite any of it unprompted. " +
  "You answer through whichever AI the person connected; you do not know for sure which model it is, so never guess. " +
  "If asked what powers you, say it is the AI they connected, run by this app's engine, an open-source program called pi.";

export default function (pi: any) {
  // The Stream can check the person's real setup (never secrets) instead of guessing.
  if (process.env.AELVYRIL_ROLE === "main") {
    pi.registerTool({
      name: "get_abilities",
      label: "Check what is set up",
      description: "What is set up on this Aelvyril right now: whether an AI is connected, the AI for chats and the AI for tasks, the installed extensions, whether coding projects are available, and whether GitHub is connected.",
      promptSnippet: "Check which AI, extensions, coding projects and GitHub are set up, before saying what you can do",
      parameters: { type: "object", properties: {} },
      async execute() {
        const url = process.env.AELVYRIL_INTERNAL_URL;
        if (!url) return { content: [{ type: "text", text: "Not available in this session." }], details: {}, isError: true };
        try {
          const res = await fetch(`${url}/internal/abilities`, { headers: { "x-aelvyril-token": process.env.AELVYRIL_INTERNAL_TOKEN ?? "" } });
          const data: any = await res.json().catch(() => ({}));
          if (!res.ok) return { content: [{ type: "text", text: `Could not check: ${data.error ?? res.status}` }], details: {}, isError: true };
          return { content: [{ type: "text", text: data.text }], details: {} };
        } catch (e) {
          return { content: [{ type: "text", text: `Could not check: ${(e as Error).message}` }], details: {}, isError: true };
        }
      },
    });
  }

  pi.on("before_agent_start", (event: any) => {
    const name = process.env.AELVYRIL_ASSISTANT_NAME || "Aelvyril";
    const you = process.env.AELVYRIL_YOUR_NAME || "";
    const who =
      `Your name is ${name}. Use that name for yourself, always, and never call yourself pi. ` +
      (you ? `The person you help likes to be called ${you}. ` : "");

    // The main conversation: pi's own preamble, tool list and docs are a coding assistant's. Swap them for the gateway's
    // instructions (passed with --append-system-prompt) plus the name and the knowledge, by setting pi's own custom-prompt
    // option. Anything other extensions add to the prompt (memory, ponytail) is kept.
    const opts = event.systemPromptOptions;
    if (process.env.AELVYRIL_ROLE === "main" && opts?.appendSystemPrompt) {
      opts.customPrompt = `${who}${opts.appendSystemPrompt}\n\n${ABOUT}`;
      opts.appendSystemPrompt = "";
      return;
    }

    // Tasks and older chats need pi's tool guidance, so keep it and put the name first.
    return { systemPrompt: `${who}\n\n${event.systemPrompt}` };
  });
}
