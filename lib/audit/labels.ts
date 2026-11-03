// Display names for audit actions. Add one whenever a route gains a new action.
export const ACTION_LABELS: Record<string, string> = {
  'team.add': 'Team member added',
  'team.remove': 'Team member removed',
  'settings.update': 'Settings changed',
  'import.upload_authorised': 'File upload started',
  'import.register': 'File uploaded for import',
  'import.analyze': 'Import file analysed',
  'import.validate': 'Import validated',
  'import.commit': 'Contacts imported',
  'import.undo': 'Import undone',
  'mapping_preset.save': 'Mapping preset saved',
  'mapping_preset.delete': 'Mapping preset deleted',
  'contact.create': 'Contact added',
  'campaign.export_failures': 'Campaign failures exported',
  'credentials.update': 'Credentials changed',
  'email.preview': 'Email audience checked',
  'email.send': 'Email sent to selected contacts',
  'email.test': 'Test email sent',
  'email.unsubscribe': 'Unsubscribed from email',
  'email.webhook_suppressed': 'Email address suppressed by Resend event',
  'suppression.add': 'Added to suppression list',
  'suppression.remove': 'Removed from suppression list',
  'snapshot.create': 'Snapshot created',
  'snapshot.restore': 'Snapshot restored',
};

export const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;
