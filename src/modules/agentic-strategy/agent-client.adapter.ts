import { Injectable } from '@nestjs/common';
import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentProposal,
} from '../../ports/agentic-strategy';

// Default, INERT agent client. A deployed-but-unwired agentic lane proposes nothing — the bot trades
// only what a real out-of-process LLM/agent later returns through a concrete adapter. Until that
// endpoint exists the lane is a structural no-op (fail-safe): no network call, no signals.
//
// A concrete adapter replacing this one would POST the input to an out-of-process agent over HTTP and
// map its response to `Signal`s. Note: money-path lint still applies in this module — a real adapter
// must build Price/Qty via decimal.js / domain money helpers, never `Number()`/`parseFloat` on a
// numeric field of the agent's JSON response.
@Injectable()
export class StubAgentClient implements AgentClientPort {
  propose(input: AgentDecisionInput): Promise<AgentProposal> {
    void input;
    return Promise.resolve({ signals: [] });
  }
}
