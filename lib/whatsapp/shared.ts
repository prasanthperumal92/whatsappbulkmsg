// Safe to import from the browser.

/** The contact fields a template variable can use. A fixed list, so a mapping can't read consent or audit columns. */
export const VARIABLE_FIELDS = ['first_name', 'last_name', 'display_name', 'company', 'city', 'email'] as const;
export const WEBHOOK_FIELDS = ['messages', 'message_template_status_update', 'phone_number_quality_update'];
