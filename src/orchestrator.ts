import fs from 'fs';
import path from 'path';
import { Database } from './db/database.js';
import { SessionManager } from './sessions/session-manager.js';
import { AgentPool } from './agents/agent-pool.js';
import { BoardManager } from './board/board-manager.js';
import { BoardEvents } from './board/board-events.js';
import { ChatHandler } from './supervisor/chat-handler.js';
import { WatchdogAgent, DEFAULT_WATCHDOG_CONFIG } from './agents/watchdog/watchdog-agent.js';
import { TestAgent } from './agents/test-agent/test-agent.js';
import { ReviewAgent } from './agents/review-agent/review-agent.js';
import { createTicketBranch } from './agents/main-agent/git-operations.js';
import { getNextDispatchable } from './agents/main-agent/wave-executor.js';
import { SharedState } from './missions/shared-state.js';
import { MilestoneLoop } from './missions/milestone-loop.js';
import { ModelAssignmentManager, DEFAULT_MODEL_ASSIGNMENT } from './missions/model-assignment.js';
import { BroadcastManager } from './missions/broadcast.js';
import type { StartMissionRequest, MissionResult, FeaturesFile, ModelAssignment } from './missions/missions.types.js';

export interface OrchestratorConfig {
  port: number;
  workspaceRoot: string;
  dbPath: string;
}

export class Orchestrator {
  public readonly db: Database;
  public readonly sessionManager: SessionManager;
  public readonly agentPool: AgentPool;
  public readonly boardEvents: BoardEvents;

  private watchdogs: Map<string, WatchdogAgent> = new Map();
  private boards: Map<string, BoardManager> = new Map();
  private missions: Map<string, SharedState> = new Map();
  private loops: Map<string, MilestoneLoop> = new Map();

  constructor(private config: OrchestratorConfig) {
    this.db = new Database(config.dbPath);
    this.sessionManager = new SessionManager(this.db, config.workspaceRoot);
    this.agentPool = new AgentPool();
    this.boardEvents = new BoardEvents();
  }

  startMission(req: StartMissionRequest): { sessionId: string; sharedState: SharedState } {
    const session = this.sessionManager.create(req.repoUrl);

    const missionDir = path.join(session.repo_path, '.aelvyril', 'missions', session.id);
    const sharedState = new SharedState(missionDir);

    const features = this.decomposeGoal(req.goal, req.context);
    const models = this.resolveModels();

    sharedState.initialize(features, models);
    this.missions.set(session.id, sharedState);

    const loop = new MilestoneLoop(
      sharedState,
      this.agentPool,
      this.sessionManager,
      this.boardEvents,
    );
    this.loops.set(session.id, loop);

    this.boardEvents.emit('agent_activity', {
      agent: 'ORCHESTRATOR',
      action: `Mission started: ${req.goal}`,
    });

    return { sessionId: session.id, sharedState };
  }

  async executeMission(sessionId: string): Promise<MissionResult> {
    const loop = this.loops.get(sessionId);
    if (!loop) throw new Error(`No mission for session ${sessionId}`);
    return loop.run();
  }

  getMissionState(sessionId: string): SharedState | undefined {
    return this.missions.get(sessionId);
  }

  startSession(repoUrl: string): { sessionId: string; board: BoardManager } {
    const session = this.sessionManager.create(repoUrl);
    const board = new BoardManager(this.db, session.id);
    this.boards.set(session.id, board);

    const memoryDbPath = `${session.repo_path}/.aelvyril/memory.db`;
    this.agentPool.spawnLongRunning('supervisor', session.id, memoryDbPath, 'supervisor');
    this.agentPool.spawnLongRunning('main_agent', session.id, memoryDbPath, 'main');
    this.agentPool.spawnLongRunning('watchdog', session.id, memoryDbPath, 'watchdog');

    const watchdog = new WatchdogAgent(this.agentPool, board, session.id, DEFAULT_WATCHDOG_CONFIG);
    watchdog.setCallbacks({
      onProgress: (report) => {
        this.boardEvents.emitBoardState({
          session_id: session.id,
          tickets: board.getTickets(),
          plan: board.getConcurrencyPlan() ?? { max_parallel: 1, waves: [], conflict_groups: [], tickets: [] },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      },
      onEscalate: (ticketId, message) => {
        this.boardEvents.emit('escalation', { session_id: session.id, ticket_id: ticketId, message });
      },
      onIntervention: (stuck, action) => {
        this.boardEvents.emit('agent_activity', {
          agent: 'WATCHDOG',
          action: `Intervention: ${action} for ${stuck.ticket_id}`,
        });
      },
    });
    watchdog.start();
    this.watchdogs.set(session.id, watchdog);

    return { sessionId: session.id, board };
  }

  async routeMessage(sessionId: string, content: string): Promise<void> {
    const board = this.boards.get(sessionId);
    if (!board) throw new Error(`Session ${sessionId} not found`);

    const session = this.sessionManager.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const chatHandler = new ChatHandler({
      onNewRequest: async (req) => {
        this.boardEvents.emit('agent_activity', {
          agent: 'TICKET_AGENT',
          action: `Decomposing request: "${req}"`,
        });
      },
      onRedirect: async (ticketId, content) => {
        this.boardEvents.emit('agent_activity', {
          agent: 'SUPERVISOR',
          action: `Redirecting ${ticketId}: ${content}`,
        });
      },
      onStatusCheck: async () => {
        const tickets = board.getTickets();
        const plan = board.getConcurrencyPlan();
        this.boardEvents.emit('supervisor_response', {
          message: `${tickets.length} tickets. Plan: ${plan ? `${plan.max_parallel} parallel, ${plan.waves.length} waves` : 'No plan yet'}`,
        });
      },
      onCancel: async () => {
        this.agentPool.killEphemeral();
        this.boardEvents.emit('supervisor_response', { message: 'All tasks cancelled.' });
      },
      onConfigUpdate: async (key, value) => {
        this.boardEvents.emit('supervisor_response', { message: `Config updated: ${key}` });
      },
    });

    await chatHandler.handleMessage(sessionId, content);
  }

  async processTickets(sessionId: string): Promise<void> {
    const board = this.boards.get(sessionId);
    if (!board) return;

    const plan = board.getConcurrencyPlan();
    if (!plan) return;

    const tickets = board.getTickets();
    const dispatchable = getNextDispatchable(tickets, plan, 0);

    for (const ticketId of dispatchable) {
      const ticket = board.getTicket(ticketId);
      if (!ticket) continue;

      board.transition(ticketId, 'in_progress');

      const session = this.sessionManager.get(sessionId);
      if (session) {
        createTicketBranch(session.repo_path, ticketId, sessionId);
      }

      this.boardEvents.emit('agent_activity', {
        agent: 'MAIN_AGENT',
        action: `Dispatched ${ticketId} (${ticket.title})`,
      });
    }
  }

  async runTests(sessionId: string, ticketId: string): Promise<void> {
    const board = this.boards.get(sessionId);
    if (!board) return;

    const session = this.sessionManager.get(sessionId);
    if (!session) return;

    const ticket = board.getTicket(ticketId);
    if (!ticket) return;

    board.transition(ticketId, 'testing');

    const testAgent = new TestAgent(this.agentPool, board, {
      sessionId,
      memoryDbPath: `${session.repo_path}/.aelvyril/memory.db`,
      workspacePath: session.repo_path,
    });

    const result = await testAgent.execute(ticket, []);

    if (result.passed) {
      board.transition(ticketId, 'in_review');
      await this.runReview(sessionId, ticketId);
    } else {
      board.transition(ticketId, 'in_progress');
      this.boardEvents.emit('agent_activity', {
        agent: 'TEST_AGENT',
        action: `Tests failed for ${ticketId}: ${result.failures.map(f => f.test_name).join(', ')}`,
      });
    }
  }

  async runReview(sessionId: string, ticketId: string): Promise<void> {
    const board = this.boards.get(sessionId);
    if (!board) return;

    const session = this.sessionManager.get(sessionId);
    if (!session) return;

    const ticket = board.getTicket(ticketId);
    if (!ticket) return;

    const reviewAgent = new ReviewAgent(this.agentPool, board, {
      sessionId,
      sessionBranch: `aelvyril/session-${sessionId}`,
      memoryDbPath: `${session.repo_path}/.aelvyril/memory.db`,
      workspacePath: session.repo_path,
    });

    const decision = await reviewAgent.execute(ticket, []);

    this.boardEvents.emit('agent_activity', {
      agent: 'REVIEW_AGENT',
      action: `${decision.approved ? 'Approved' : 'Rejected'} ${ticketId}: ${decision.summary}`,
    });
  }

  destroySession(sessionId: string): void {
    const watchdog = this.watchdogs.get(sessionId);
    watchdog?.stop();
    this.watchdogs.delete(sessionId);
    this.boards.delete(sessionId);
    this.loops.delete(sessionId);
    this.missions.delete(sessionId);

    const session = this.sessionManager.get(sessionId);
    if (session) {
      const agentIds = ['supervisor', 'main_agent', 'watchdog'];
      for (const id of agentIds) {
        this.agentPool.kill(id);
      }
      if (session.repo_path) {
        try {
          fs.rmSync(session.repo_path, { recursive: true, force: true });
        } catch {}
      }
    }

    this.sessionManager.complete(sessionId);
  }

  getBoard(sessionId: string): BoardManager | undefined {
    return this.boards.get(sessionId);
  }

  shutdown(): void {
    for (const [id] of this.watchdogs) {
      this.watchdogs.get(id)?.stop();
    }
    this.agentPool.killAll();
    this.db.close();
  }

  private decomposeGoal(goal: string, context?: string): FeaturesFile {
    return {
      mission_name: goal.substring(0, 60),
      goal,
      milestones: [{
        index: 0,
        name: 'Implementation',
        features: ['#1'],
        status: 'pending',
        retry_count: 0,
      }],
      features: [{
        id: '#1',
        title: goal.substring(0, 80),
        description: goal,
        acceptance_criteria: [context ?? 'Implement the goal'],
        files: [],
        status: 'pending',
        assigned_worker: null,
      }],
      current_milestone_index: 0,
    };
  }

  private resolveModels(): ModelAssignment {
    return { ...DEFAULT_MODEL_ASSIGNMENT };
  }
}
