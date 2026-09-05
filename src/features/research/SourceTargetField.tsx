import { Link } from "react-router";

export const SOURCE_TARGET_OPTIONS = [3, 4, 5, 6, 7, 8, 9, 10] as const;

export default function SourceTargetField({ value, onChange }: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  return <div className="research-field research-field--compact">
    <label className="research-field">
      <span>Source target</span>
      <select aria-label="Source target" value={value ?? ""} onChange={(event) => onChange(event.target.value ? Number(event.target.value) : undefined)}>
        <option value="">Use Agent playbook</option>
        {SOURCE_TARGET_OPTIONS.map((count) => <option key={count} value={count}>{count} independent publishers</option>)}
      </select>
    </label>
    <small>Target across the whole report, not per player or position. Includes known and newly discovered publishers. Fewer may be verifiable. <Link className="text-button" to="/agents">Set the default in Agent playbook</Link>.</small>
    {value !== undefined && value > 5 && <small>Use desktop 0.1.11 or newer for more than five ranking sources. Larger targets take more time and subscription usage.</small>}
  </div>;
}
