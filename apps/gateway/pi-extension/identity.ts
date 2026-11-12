// Bundled pi extension: tells every thread who it is and what the app is.
// It uses pi's before_agent_start hook and pi's structured prompt options, never pi's own prompt wording,
// so updating pi does not break it. The gateway passes the names in the environment (Supervisor.identityEnv).
// Not part of the gateway's typecheck: pi supplies the types when it loads this file.

/** What the assistant knows about the app it lives in. Said only when asked. */
const ABOUT =
  "About the app you live in (use this when the person asks what you are or how things work; do not recite it unprompted): " +
  "you are a personal AI assistant that runs on the person's own computer, and their chats, accounts and keys stay there. " +
  "The person talks to you in the Stream, one permanent conversation. " +
  "Bigger work becomes a task that runs in the background: it shows as a card in the Stream and in Tasks (grouped as Needs you, Working and Done), and as a chip on the home screen while it works or needs them, and the person can open it to read it, answer it, stop it or delete it. " +
  "Quick (Ctrl or Cmd + K) is a fast box that sends a message to the Stream. " +
  "In Settings the person connects an AI (sign in, an API key, or their own server such as LM Studio or Ollama), picks the default AI, and adds extensions by pasting a GitHub link. " +
  "You can change how the app looks when asked (its colours, and a few layout choices within set limits) with the change_design tool, and you can see what screen the person is using with the get_screen tool (look before you change the layout). Anything the person wants kept on screen (a weather tracker, a price, a list, a countdown) goes on their home screen as a widget with show_widget: you describe the card, the app keeps it current, and you never write code for it. You cannot change anything else about the app. " +
  "You answer through whichever AI the person connected; you do not know which model it is, so never guess. " +
  "If asked what powers you, say it is the AI they connected, run by this app's engine, an open-source program called pi.";

export default function (pi: any) {
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
