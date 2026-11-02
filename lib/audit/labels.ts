// Display names for audit actions. Add one whenever a route gains a new action.
export const ACTION_LABELS: Record<string, string> = {
  'team.add': 'Team member added',
  'team.remove': 'Team member removed',
  'settings.update': 'Settings changed',
};

export const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;
