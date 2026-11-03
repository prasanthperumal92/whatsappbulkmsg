// §5.12 and §7A.4: blocks → React Email → HTML, plus a plain-text part. Same input, byte-identical output, because a
// retried batch must match its idempotency key. Values are HTML-escaped by React in the HTML part, raw in the text
// part and subject, and URL-encoded in URLs. The footer isn't a block, so a template can't remove it. The signature
// comes from Settings, so its {{…}} stay literal and it can't pull in a contact's values.

import { Body, Button, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { Fragment, type CSSProperties, type ReactNode } from 'react';

export type EmailBlock =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'image'; src: string; alt: string; link?: string }
  | { type: 'button'; label: string; url: string }
  | { type: 'divider' }
  | { type: 'spacer'; height?: number };

export type EmailFooter = { businessName: string; postalAddress: string; unsubscribeUrl: string; privacyUrl?: string | null; signature?: string | null };

/** Fills a template string. `url` is true when the value lands in a URL and must be encoded. */
export type Fill = (template: string, url?: boolean) => string;

const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const FONT = 'Helvetica, Arial, sans-serif';

const styles = {
  body: { backgroundColor: '#ffffff', color: INK, fontFamily: FONT, margin: 0 },
  container: { maxWidth: '600px', margin: '0 auto', padding: '24px' },
  heading: { color: INK, fontSize: '24px', lineHeight: '32px', margin: '0 0 16px' },
  text: { color: INK, fontSize: '16px', lineHeight: '24px', margin: '0 0 16px' },
  button: { backgroundColor: '#111827', borderRadius: '6px', color: '#ffffff', display: 'inline-block', fontSize: '16px', padding: '12px 20px', textDecoration: 'none' },
  image: { display: 'block', height: 'auto', maxWidth: '100%' },
  rule: { borderColor: LINE, margin: '24px 0' },
  footer: { color: MUTED, fontSize: '13px', lineHeight: '20px', margin: '0 0 4px' },
  footerLink: { color: MUTED, textDecoration: 'underline' },
  link: { color: '#1d4ed8', textDecoration: 'underline' },
  section: { margin: '0 0 16px' },
} satisfies Record<string, CSSProperties>;

type Inline = { kind: 'plain' | 'bold' | 'italic'; text: string } | { kind: 'link'; text: string; url: string };

// Marks are read from the template before any value goes in, so a contact's name can't add formatting or a link.
// Underscores inside words and variables, as in {{first_name}}, aren't italics.
const MARK = /\*([^*\n]+)\*|(?<![\p{L}\p{N}_{])_([^_\n]+)_(?![\p{L}\p{N}_}])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gu;

export function parseInline(template: string): Inline[] {
  const parts: Inline[] = [];
  let last = 0;
  for (const m of template.matchAll(MARK)) {
    if (m.index > last) parts.push({ kind: 'plain', text: template.slice(last, m.index) });
    if (m[1] !== undefined) parts.push({ kind: 'bold', text: m[1] });
    else if (m[2] !== undefined) parts.push({ kind: 'italic', text: m[2] });
    else parts.push({ kind: 'link', text: m[3]!, url: m[4]! });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ kind: 'plain', text: template.slice(last) });
  return parts;
}

const literal: Fill = (text) => text;

/** Marks can't span lines, so only plain text can hold a line break. */
function withBreaks(text: string): ReactNode {
  if (!text.includes('\n')) return text;
  return text.split('\n').map((line, i) => <Fragment key={i}>{i > 0 && <br />}{line}</Fragment>);
}

function inlineHtml(template: string, fill: Fill): ReactNode {
  return parseInline(template).map((part, i) => {
    const text = fill(part.text);
    if (part.kind === 'bold') return <strong key={i}>{text}</strong>;
    if (part.kind === 'italic') return <em key={i}>{text}</em>;
    if (part.kind === 'link') return <Link key={i} href={fill(part.url, true)} style={styles.link}>{text}</Link>;
    return <Fragment key={i}>{withBreaks(text)}</Fragment>;
  });
}

function blockHtml(block: EmailBlock, key: number, fill: Fill): ReactNode {
  switch (block.type) {
    case 'heading':
      return <Heading key={key} as="h1" style={styles.heading}>{fill(block.text)}</Heading>;
    case 'text':
      return <Text key={key} style={styles.text}>{inlineHtml(block.text, fill)}</Text>;
    case 'image': {
      const image = <Img src={block.src} alt={fill(block.alt)} style={styles.image} />;
      return <Section key={key} style={styles.section}>{block.link ? <Link href={fill(block.link, true)}>{image}</Link> : image}</Section>;
    }
    case 'button':
      return <Section key={key} style={styles.section}><Button href={fill(block.url, true)} style={styles.button}>{fill(block.label)}</Button></Section>;
    case 'divider':
      return <Hr key={key} style={styles.rule} />;
    case 'spacer':
      return <Section key={key} style={{ height: `${block.height ?? 16}px` }} />;
  }
}

export function renderHtml({ blocks, preheader, footer, fill }: { blocks: EmailBlock[]; preheader?: string | null; footer: EmailFooter; fill: Fill }): Promise<string> {
  return render(
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light only" />
      </Head>
      {preheader ? <Preview>{fill(preheader)}</Preview> : null}
      <Body style={styles.body}>
        <Container style={styles.container}>
          {blocks.map((block, i) => blockHtml(block, i, fill))}
          {footer.signature ? <Text style={styles.text}>{inlineHtml(footer.signature, literal)}</Text> : null}
          <Hr style={styles.rule} />
          <Text style={styles.footer}>{`${footer.businessName}, ${footer.postalAddress}`}</Text>
          <Text style={styles.footer}>
            <Link href={footer.unsubscribeUrl} style={styles.footerLink}>Unsubscribe</Link>
            {footer.privacyUrl ? <>{' · '}<Link href={footer.privacyUrl} style={styles.footerLink}>Privacy notice</Link></> : null}
          </Text>
        </Container>
      </Body>
    </Html>,
  );
}

function inlineText(template: string, fill: Fill): string {
  return parseInline(template)
    .map((part) => (part.kind === 'link' ? `${fill(part.text)} (${fill(part.url, true)})` : fill(part.text)))
    .join('');
}

function blockText(block: EmailBlock, fill: Fill): string | null {
  switch (block.type) {
    case 'heading':
      return fill(block.text);
    case 'text':
      return inlineText(block.text, fill);
    case 'image':
      return block.link ? `${fill(block.alt)}: ${fill(block.link, true)}` : fill(block.alt);
    case 'button':
      return `${fill(block.label)}: ${fill(block.url, true)}`;
    case 'divider':
    case 'spacer':
      return null;
  }
}

export function renderText({ blocks, footer, fill }: { blocks: EmailBlock[]; footer: EmailFooter; fill: Fill }): string {
  const body = blocks.map((block) => blockText(block, fill)).filter((part) => part !== null);
  if (footer.signature) body.push(inlineText(footer.signature, literal));
  const lines = [`—`, `${footer.businessName}, ${footer.postalAddress}`, `Unsubscribe: ${footer.unsubscribeUrl}`];
  if (footer.privacyUrl) lines.push(`Privacy notice: ${footer.privacyUrl}`);
  return [...body, lines.join('\n')].join('\n\n');
}
