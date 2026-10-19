import { useState, type ReactNode } from 'react';
import { Box, CircleDot, Hand, Minus, Mountain, Plus, Rotate3d, Slice, Type } from 'lucide-react';
import { Button, Popover, Tip } from './ui/primitives';

export type CubeMode = 'orbit' | 'pan' | 'slice';
export type ViewMode = 'cube' | 'radial';

const modes = [
  { id: 'orbit', label: 'Orbit', hint: 'Drag to rotate the cube', Icon: Rotate3d },
  { id: 'pan', label: 'Pan', hint: 'Drag to move the view', Icon: Hand },
  { id: 'slice', label: 'Slice', hint: 'Drag a face to slice the cube', Icon: Slice },
] as const;

/** Floating tools above the visualization. In the flat view, cube-only tools are disabled. */
export function CubeToolbar({
  view,
  onView,
  mode,
  onMode,
  onReset,
  onZoom,
  zoom,
  showLabels,
  onLabels,
  showRelief,
  onRelief,
  reliefMenu,
}: {
  view: ViewMode;
  onView: (view: ViewMode) => void;
  mode: CubeMode;
  onMode: (mode: CubeMode) => void;
  onReset: () => void;
  onZoom: (step: number) => void;
  zoom: number;
  showLabels: boolean;
  onLabels: () => void;
  showRelief: boolean;
  onRelief?: () => void;
  /** Terrain options, opened from the relief button. */
  reliefMenu: ReactNode;
}) {
  const [focused, setFocused] = useState(0);
  /** The relief button turns terrain on and opens its options; a second click turns it off.
   * Clicking elsewhere only closes the options. */
  const [reliefOpen, setReliefOpen] = useState(false);
  const clickRelief = () => {
    onRelief?.();
    setReliefOpen(!showRelief);
  };
  const flat = view === 'radial';
  const actions: {
    label: string;
    hint: string;
    content: ReactNode;
    pressed?: boolean;
    onClick?: () => void;
    disabled: boolean;
    menu?: ReactNode;
    separator?: boolean;
  }[] = [
    {
      label: 'Cube view',
      hint: 'Show the forecast as a 3D cube',
      content: <Box size={15} aria-hidden="true" />,
      pressed: !flat,
      onClick: () => onView('cube'),
      disabled: false,
    },
    {
      label: 'Flat view',
      hint: 'Show the runs as a flat radial view',
      content: <CircleDot size={15} aria-hidden="true" />,
      pressed: flat,
      onClick: () => onView('radial'),
      disabled: false,
    },
    ...modes.map(({ id, label, hint, Icon }, i) => ({
      label,
      hint: flat ? 'Only in the cube view' : hint,
      content: (
        <>
          <Icon size={15} aria-hidden="true" />
          {id === 'slice' && <span>Slice</span>}
        </>
      ),
      pressed: !flat && mode === id,
      onClick: () => onMode(id),
      disabled: flat,
      separator: i === 0,
    })),
    {
      label: 'Reset cube',
      hint: flat ? 'Only in the cube view' : 'Restore the full cube and camera',
      content: <>Reset</>,
      onClick: onReset,
      disabled: flat,
      separator: true,
    },
    {
      label: 'Zoom in',
      hint: 'Zoom in',
      content: <Plus size={16} aria-hidden="true" />,
      onClick: () => onZoom(0.2),
      disabled: flat || zoom >= 3,
    },
    {
      label: 'Zoom out',
      hint: 'Zoom out',
      content: <Minus size={16} aria-hidden="true" />,
      onClick: () => onZoom(-0.2),
      disabled: flat || zoom <= -2,
    },
    {
      label: 'Place labels',
      hint: showLabels ? 'Hide place names' : 'Show place names',
      content: <Type size={16} aria-hidden="true" />,
      pressed: !flat && showLabels,
      onClick: onLabels,
      disabled: flat,
      separator: true,
    },
    {
      label: 'Relief',
      hint: flat ? 'Only in the cube view' : 'Terrain options',
      content: <Mountain size={16} aria-hidden="true" />,
      pressed: !flat && showRelief,
      onClick: clickRelief,
      disabled: flat,
      menu: reliefMenu,
    },
  ];

  return (
    <div
      className="camera-tools"
      data-view={view}
      role="toolbar"
      aria-label="Visualization controls"
      onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const buttons = Array.from(
          e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        );
        const current = buttons.indexOf(e.target as HTMLButtonElement);
        const next =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? buttons.length - 1
              : (current + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      {actions.map((action, index) => {
        const button = (
          <Button
            variant="ghost"
            className={`icon ${action.pressed ? 'active' : ''}`}
            aria-label={action.label}
            aria-pressed={action.pressed}
            tabIndex={index === (actions[focused]?.disabled ? 0 : focused) ? 0 : -1}
            disabled={action.disabled}
            onFocus={() => setFocused(index)}
            onClick={action.onClick}
          >
            {action.content}
          </Button>
        );

        return (
          <span className="camera-action" key={action.label}>
            {action.separator && <span className="camera-separator" aria-hidden="true" />}
            {action.menu && !action.disabled ? (
              <Popover
                trigger={button}
                align="end"
                open={reliefOpen && showRelief}
                onOpenChange={(open) => {
                  if (!open) setReliefOpen(false);
                }}
              >
                {action.menu}
              </Popover>
            ) : (
              <Tip label={action.hint}>{button}</Tip>
            )}
          </span>
        );
      })}
    </div>
  );
}
