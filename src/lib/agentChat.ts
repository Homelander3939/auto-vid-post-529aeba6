export interface AgentChatAttachment {
  name: string;
  type?: string;
  size?: string;
  url?: string;
  textContent?: string;
  isImage?: boolean;
}

// IMPORTANT: This heuristic is mirrored on the backend at
// `supabase/functions/_shared/agent-intent.ts`. The backend version is the
// authoritative one (used by ai-chat to decide whether to launch run_agent
// when the LLM doesn't pick the tool itself). This client copy exists only
// to keep the UI hint instant — keep both in sync when editing.
const AGENTIC_PATTERNS = [
  /\bagentic\b/i,
  /\bautonomous\b/i,
  /\bstep[\s-]*by[\s-]*step\b/i,
  /\bresearch\b[\s\S]{0,80}\b(build|create|generate|write|design|code)\b/i,
  /\b(build|create|generate|design|code|prototype|develop)\b[\s\S]{0,80}\b(app|website|landing page|portfolio|workflow|automation|agent|flow)\b/i,
  /\bclaude code\b|\bcodex\b|\bopenclaw\b/i,
];
const MAX_ATTACHMENT_PREVIEW_LENGTH = 1_200;

export function shouldLaunchAgentRun(text: string, files: AgentChatAttachment[] = []): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized && files.length === 0) return false;
  if (files.length > 0 && files.some((file) => !file.isImage && !!file.textContent)) return true;
  return AGENTIC_PATTERNS.some((pattern) => pattern.test(normalized));
}

function describeAttachment(file: AgentChatAttachment): string {
  const meta = [file.type, file.size].filter(Boolean).join(', ');
  const preview = file.textContent
    ? `\nPreview:\n${file.textContent.slice(0, MAX_ATTACHMENT_PREVIEW_LENGTH)}${file.textContent.length > MAX_ATTACHMENT_PREVIEW_LENGTH ? '\n…' : ''}`
    : '';
  return `- ${file.name}${meta ? ` (${meta})` : ''}${file.url ? `\nURL: ${file.url}` : ''}${preview}`;
}

export function buildAgentRunPrompt(text: string, files: AgentChatAttachment[] = []): string {
  const normalized = text.trim();
  const attachmentSummary = files.length > 0
    ? `\n\nAttached files:\n${files.map(describeAttachment).join('\n\n')}`
    : '';
  const task = normalized || 'Review the attached files and complete the requested workflow.';
  return `${task}${attachmentSummary}\n\nRequirements:\n- Execute this as a real autonomous agent run.\n- Show live progress in the app.\n- If something cannot run, report the exact error and blocking step.\n- Save durable memory only when it is genuinely reusable.`;
}
