import readline from 'readline';
import { WSClient } from './ws-client.js';
import {
  formatSupervisorResponse,
  formatTicketEvent,
  formatAgentActivity,
  formatCostUpdate,
  formatProgressReport,
  formatError,
} from './output-formatter.js';

interface ChatConfig {
  port?: number;
  session?: string;
}

export function startChat(config: ChatConfig = {}): void {
  const port = config.port ?? 3000;
  const url = `ws://localhost:${port}/ws`;

  const client = new WSClient({ url });
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
    historySize: 100,
  });

  console.log(`\x1b[1m\x1b[36mAelvyril Chat\x1b[0m — connecting to ${url}...\n`);

  client.on('connected', () => {
    console.log(`\x1b[32m● Connected\x1b[0m\n`);
    rl.prompt();
  });

  client.on('disconnected', () => {
    console.log(`\x1b[31m○ Disconnected\x1b[0m — reconnecting...`);
  });

  client.on('message', (data: unknown) => {
    const msg = data as { event: string; data: unknown };
    handleEvent(msg.event, msg.data);
    rl.prompt(true);
  });

  function handleEvent(event: string, data: unknown): void {
    switch (event) {
      case 'supervisor_response':
        console.log(formatSupervisorResponse((data as any).message ?? String(data)));
        break;

      case 'ticket_created':
        console.log(formatTicketEvent((data as any).ticket_id ?? (data as any).id, 'backlog', null));
        break;

      case 'ticket_transition':
        console.log(formatTicketEvent(
          (data as any).ticket_id,
          (data as any).to,
          (data as any).from
        ));
        break;

      case 'ticket_held':
        console.log(formatTicketEvent((data as any).ticket_id, 'held', null));
        break;

      case 'ticket_released':
        console.log(formatTicketEvent((data as any).ticket_id, 'in_progress', 'held'));
        break;

      case 'agent_activity':
        console.log(formatAgentActivity(
          (data as any).agent,
          (data as any).action
        ));
        break;

      case 'cost_update':
        console.log(formatCostUpdate(
          (data as any).total_tokens ?? 0,
          (data as any).total_cost_usd ?? 0
        ));
        break;

      case 'progress_report':
        console.log(formatProgressReport(data as any));
        break;

      default:
        console.log(`${JSON.stringify(data)}`);
    }
  }

  function handleCommand(line: string): boolean {
    const trimmed = line.trim();

    if (trimmed === '/help') {
      console.log(`
\x1b[1mCommands:\x1b[0m
  /status   — Show current board status
  /cost     — Show cost breakdown
  /help     — Show this help
  /exit     — Exit chat
  Ctrl+C    — Exit chat
`);
      return true;
    }

    if (trimmed === '/exit') {
      client.disconnect();
      rl.close();
      process.exit(0);
    }

    if (trimmed === '/status') {
      client.send('chat_message', { content: 'status' });
      return true;
    }

    if (trimmed === '/cost') {
      client.send('chat_message', { content: 'cost' });
      return true;
    }

    return false;
  }

  rl.on('line', (line) => {
    if (!line.trim()) {
      rl.prompt();
      return;
    }

    if (line.startsWith('/')) {
      handleCommand(line);
      rl.prompt();
      return;
    }

    client.send('chat_message', { content: line, session_id: config.session });
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n\x1b[33mGoodbye.\x1b[0m');
    client.disconnect();
    process.exit(0);
  });

  client.connect();
}

export function runCli(): void {
  const args = process.argv.slice(2);
  let port = 3000;
  let session: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--session' && args[i + 1]) {
      session = args[i + 1];
      i++;
    } else if (args[i] === '--help') {
      console.log(`
\x1b[1mUsage:\x1b[0m aelvyril chat [options]

\x1b[1mOptions:\x1b[0m
  --port <port>      Orchestrator port (default: 3000)
  --session <id>     Connect to specific session
  --help             Show this help
`);
      process.exit(0);
    }
  }

  startChat({ port, session });
}
