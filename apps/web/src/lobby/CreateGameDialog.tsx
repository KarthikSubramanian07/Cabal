/**
 * Set a new table: every setting a lobby decides, each with a line saying what it means. The
 * defaults are the protocol's own (`resolveSettings`), so a player who changes nothing gets the
 * game the server would have made anyway. On success the creator's seat token is kept on this
 * device and the page moves to the table's lobby.
 */
import {
  type AiBrain,
  type GameSettingsInput,
  type Pacing,
  type PressMode,
  type Scoring,
  type Visibility,
  resolveSettings,
} from "@cabal/protocol";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { navigate } from "../app/router.jsx";
import { api, failureText } from "../net/api.js";
import { readName } from "../net/seats.js";
import { PACING, PRESS, RULEBOOK, SCORING } from "./terms.js";
import { keepCreatedSeat } from "./useRoom.js";

type Rulebook = keyof typeof RULEBOOK;

interface Choice<T extends string> {
  value: T;
  label: string;
  blurb: string;
}

function Options<T extends string>({
  legend,
  name,
  value,
  choices,
  onChange,
  disabled,
}: {
  legend: string;
  name: string;
  value: T;
  choices: Choice<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="options" disabled={disabled}>
      <legend>{legend}</legend>
      <div className="options-list">
        {choices.map((c) => (
          <label key={c.value} className="option">
            <input type="radio" name={name} value={c.value} checked={value === c.value} onChange={() => onChange(c.value)} />
            <span className="option-label">{c.label}</span>
            <span className="option-blurb">{c.blurb}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Toggle({ label, blurb, checked, onChange }: { label: string; blurb: ReactNode; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="option toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="option-label">{label}</span>
      <span className="option-blurb">{blurb}</span>
    </label>
  );
}

const DEFAULTS = resolveSettings({ visibility: "public" });

export function CreateGameDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const errorId = useId();
  const [name, setName] = useState("");
  const [pacing, setPacing] = useState<Pacing>(DEFAULTS.pacing);
  const [press, setPress] = useState<PressMode>(DEFAULTS.press);
  const [rulebook, setRulebook] = useState<Rulebook>(DEFAULTS.rulebook);
  const [dias, setDias] = useState(DEFAULTS.dias);
  const [scoring, setScoring] = useState<Scoring>(DEFAULTS.scoring);
  const [aiFill, setAiFill] = useState(DEFAULTS.aiFill);
  const [aiBrain, setAiBrain] = useState<AiBrain>(DEFAULTS.aiBrain);
  const [visibility, setVisibility] = useState<Visibility>(DEFAULTS.visibility);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setName((current) => current || readName());
      setError(null);
      d.showModal();
      nameInput.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Write the name the table will know you by.");
      nameInput.current?.focus();
      return;
    }
    const settings: GameSettingsInput = { pacing, press, rulebook, dias, scoring, aiFill, aiBrain, visibility };
    setBusy(true);
    setError(null);
    try {
      const res = await api.createGame({ name: trimmed, settings });
      keepCreatedSeat({ gameId: res.gameId, power: res.power, token: res.token, name: trimmed });
      onClose();
      navigate(`/g/${res.gameId}`);
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="how create" onClose={onClose} aria-labelledby={titleId}>
      <header>
        <h2 id={titleId}>Set a new table</h2>
        <button type="button" className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <form className="create-form" onSubmit={submit} noValidate aria-describedby={error ? errorId : undefined}>
        <div className="field">
          <label htmlFor="create-name">Your name at the table</label>
          <input
            ref={nameInput}
            id="create-name"
            name="name"
            autoComplete="nickname"
            maxLength={32}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={error !== null && name.trim() === ""}
          />
          <p className="field-note">You are dealt a power at random. The other six seats open for players.</p>
        </div>

        <div className="create-columns">
          <div>
            <Options
              legend="Pacing"
              name="pacing"
              value={pacing}
              onChange={setPacing}
              choices={(["live", "daily", "async"] as const).map((v) => ({ value: v, ...PACING[v] }))}
            />
            <Options
              legend="Press"
              name="press"
              value={press}
              onChange={setPress}
              choices={(["full", "public", "gunboat"] as const).map((v) => ({ value: v, ...PRESS[v] }))}
            />
            <div className="field">
              <label htmlFor="create-rulebook">Rules</label>
              <select id="create-rulebook" value={rulebook} onChange={(e) => setRulebook(e.target.value as Rulebook)} aria-describedby="create-rulebook-note">
                {(Object.keys(RULEBOOK) as Rulebook[]).map((v) => (
                  <option key={v} value={v}>
                    {RULEBOOK[v].label}
                  </option>
                ))}
              </select>
              <p className="field-note" id="create-rulebook-note">
                {RULEBOOK[rulebook].blurb}
              </p>
            </div>
          </div>

          <div>
            <fieldset className="options">
              <legend>Draws</legend>
              <div className="options-list">
                <Toggle
                  label="Include all survivors"
                  blurb="A draw is shared by every power still on the board. Clear this to let a draw name who shares it."
                  checked={dias}
                  onChange={setDias}
                />
              </div>
            </fieldset>
            <Options
              legend="Scoring"
              name="scoring"
              value={scoring}
              onChange={setScoring}
              choices={(["sos", "dss"] as const).map((v) => ({ value: v, ...SCORING[v] }))}
            />
            <fieldset className="options">
              <legend>Seats</legend>
              <div className="options-list">
                <Toggle
                  label="Fill empty seats when I start"
                  blurb="Start whenever you like; seats nobody took are played for you. Clear this to wait for all seven players."
                  checked={aiFill}
                  onChange={setAiFill}
                />
              </div>
            </fieldset>
            <Options
              legend="Who plays the filled seats"
              name="brain"
              value={aiBrain}
              onChange={setAiBrain}
              disabled={!aiFill}
              choices={[
                { value: "bot", label: "The bot", blurb: "Cabal's own player. Free, and it moves at once." },
                { value: "claude", label: "Claude", blurb: "Plays and negotiates within a spending cap. The bot takes over if Claude is unavailable." },
              ]}
            />
            <Options
              legend="Listing"
              name="visibility"
              value={visibility}
              onChange={setVisibility}
              choices={[
                { value: "public", label: "List it in the games room", blurb: "Anyone can find the table and take a seat." },
                { value: "unlisted", label: "Only by code or link", blurb: "Share the code with the people you want." },
              ]}
            />
          </div>
        </div>

        {error ? (
          <p className="form-error" id={errorId} role="alert">
            {error}
          </p>
        ) : null}

        <div className="create-actions">
          <button type="submit" className="btn brass" disabled={busy}>
            {busy ? "Setting the table" : "Set the table"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
