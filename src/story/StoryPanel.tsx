import { useEffect, useRef, type ReactNode } from 'react';

export type SectionId =
  'forecast' | 'certainty' | 'members' | 'normal' | 'persistent' | 'clock' | 'sql';

export type Section = {
  id: SectionId;
  /** Short label for the progress ticks. */
  label: string;
  question: string;
  intro: ReactNode;
};

export const sections: Section[] = [
  {
    id: 'forecast',
    label: 'Forecast',
    question: 'What will the weather be?',
    intro:
      'Each layer of the cube is the map at one forecast time, and time runs upward. With terrain on, every layer is bent by the mountains beneath it.',
  },
  {
    id: 'certainty',
    label: 'Certainty',
    question: 'How sure is the forecast, and where?',
    intro:
      'The model is run many times from slightly different starts. Disagreement shows, cell by cell, where the runs part ways. Trust horizon sums it up: how far ahead each place stays reliable.',
  },
  {
    id: 'members',
    label: 'Runs',
    question: 'Which runs are warmer or colder than average?',
    intro:
      'At one moment, each layer is one run minus the average of all runs. Runs above the average stack upward; runs below hang upside down, across a wide gap from the average plane.',
  },
  {
    id: 'normal',
    label: 'Normal',
    question: 'Is it unusual for this time of year?',
    intro:
      'Compare the forecast with what is normal for the same date and hour, built from past years of analysis data.',
  },
  {
    id: 'persistent',
    label: 'Events',
    question: 'Where is an event more persistent?',
    intro:
      'Find places where a condition holds without a break for a minimum time. Isolate those cells, or paint them on top of the whole cube.',
  },
  {
    id: 'clock',
    label: 'Clock',
    question: 'How does the region’s average change?',
    intro:
      'The dial around the cube is a clock of the forecast: each arc is one layer’s area-weighted average, read clockwise from the top. The round marker shows the current layer and its value.',
  },
  {
    id: 'sql',
    label: 'SQL',
    question: 'What else do you want to ask?',
    intro:
      'Write your own query over every loaded cell. Include cell_id to see matches in the cube.',
  },
];

/** A scrolling column of questions; the section crossing the reading line drives the cube. */
export function StoryPanel({
  active,
  onActive,
  jump,
  topbar,
  header,
  children,
  footer,
}: {
  /** Pinned at the top of the panel while it scrolls. */
  topbar?: ReactNode;
  active: SectionId;
  onActive: (id: SectionId) => void;
  /** Set to a section id to scroll it into view. */
  jump: { id: SectionId; n: number } | null;
  header: ReactNode;
  children: Record<SectionId, ReactNode>;
  footer?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<SectionId, HTMLElement>());

  /** While a jump scrolls the panel, the jumped-to section stays active. */
  const lockUntil = useRef(0);

  useEffect(() => {
    const container = root.current;
    if (!container) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (performance.now() < lockUntil.current) return;
      const line = container.getBoundingClientRect().top + container.clientHeight * 0.25;
      let current: SectionId | null = null;
      for (const s of sections) {
        const el = refs.current.get(s.id);
        if (el && el.getBoundingClientRect().top <= line) current = s.id;
      }
      onActive(current ?? sections[0].id);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    container.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [onActive]);

  useEffect(() => {
    if (!jump) return;
    lockUntil.current = performance.now() + 1200;
    onActive(jump.id);
    refs.current.get(jump.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [jump]);

  return (
    <div className="story-panel" ref={root}>
      {topbar && <div className="story-topbar">{topbar}</div>}
      <div className="story-header">{header}</div>
      {sections.map((section, i) => (
        <section
          key={section.id}
          data-section={section.id}
          ref={(el) => {
            if (el) refs.current.set(section.id, el);
          }}
          className={`story-section ${active === section.id ? 'active' : ''}`}
          onClick={() => {
            if (active === section.id) return;
            lockUntil.current = performance.now() + 1200;
            onActive(section.id);
            refs.current.get(section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          aria-current={active === section.id ? 'step' : undefined}
        >
          <p className="story-kicker">
            {String(i + 1).padStart(2, '0')} · {section.label}
          </p>
          <h2>{section.question}</h2>
          <p className="story-intro">{section.intro}</p>
          <div className="story-body">{children[section.id]}</div>
        </section>
      ))}
      {footer}
    </div>
  );
}

/** Morphocode-style answer figures: a big monospace value with a small caption. */
export function Figures({ items }: { items: [string, string][] }) {
  return (
    <div className="story-figures">
      {items.map(([value, caption]) => (
        <div key={caption}>
          <b>{value}</b>
          <span>{caption}</span>
        </div>
      ))}
    </div>
  );
}

/** Progress ticks along the cube's left edge; the active section's tick is longest. */
export function StoryTicks({
  active,
  onJump,
}: {
  active: SectionId;
  onJump: (id: SectionId) => void;
}) {
  return (
    <nav className="story-ticks" aria-label="Story sections">
      {sections.map((s) => (
        <button
          key={s.id}
          className={s.id === active ? 'active' : ''}
          title={s.question}
          aria-label={s.question}
          onClick={() => onJump(s.id)}
        >
          <span />
          <em>{s.label}</em>
        </button>
      ))}
    </nav>
  );
}
