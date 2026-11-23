import type { Action } from '../../driver/types';

export function agentNoteDetail(text: string): string {
  return text.length > 90 ? `${text.slice(0, 87)}… (saved to PLAN.md)` : `${text} (saved to PLAN.md)`;
}

export function describeAction(action: Action): string {
  switch (action.type) {
    case 'goto':
      return `goto ${action.url}`;
    case 'new_tab':
      return `new_tab ${action.url ?? '(blank)'}`;
    case 'switch_tab':
      return `switch_tab ${action.tabId}`;
    case 'close_tab':
      return `close_tab ${action.tabId}`;
    case 'click':
      return action.trusted ? `trusted click ${action.ref}` : `click ${action.ref}`;
    case 'click_at':
      return `click_at ${Math.round(action.x)},${Math.round(action.y)}`;
    case 'hover':
      return `hover ${action.ref}`;
    case 'fill':
      return `fill ${action.ref} "${action.text.slice(0, 40)}"`;
    case 'select':
      return `select ${action.ref} "${action.option}"`;
    case 'press':
      return `press ${action.key}${action.modifiers?.length ? `+${action.modifiers.join('+')}` : ''}`;
    case 'scroll':
      return `scroll ${action.direction}${action.amount ? ` ${action.amount}` : ''}`;
    case 'wait':
      return `wait ${action.ms}ms`;
    case 'evaluate_js':
      return `evaluate_js ${action.expression.replace(/\s+/g, ' ').slice(0, 50)}`;
    case 'screenshot':
      return `screenshot${action.fullPage ? ' (full page)' : ''}`;
    case 'extract':
      return `extract "${action.goal.slice(0, 40)}"`;
  }
}
