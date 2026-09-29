export function StepsEditor({
  steps,
  running,
  onSet,
  onRemove,
  onAdd,
}: {
  steps: string[];
  running: boolean;
  onSet: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}) {
  return (
    <div className="steps-editor">
      {steps.map((s, i) => (
        <div key={i} className="step-row">
          <span className="step-n">{i + 1}</span>
          <input
            value={s}
            onChange={(e) => onSet(i, e.target.value)}
            placeholder={`step ${i + 1} - e.g. ${i === 0 ? 'check all posts, list every uni in unis.md' : i === 1 ? 'write ielts-requirements.md per uni' : 'verify both files'}`}
            disabled={running}
          />
          <button className="icon-btn" onClick={() => onRemove(i)} disabled={running || steps.length === 1} title="remove step">
            ×
          </button>
        </div>
      ))}
      <button className="ghost" onClick={onAdd} disabled={running}>
        + add step
      </button>
    </div>
  );
}
