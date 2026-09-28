import { create } from "zustand";
import { persist } from "zustand/middleware";

import { browserStorage } from "./browser-storage";

/** Where Higgsfield's own studio defaults the slider. */
export const DEFAULT_CHARACTER_STRENGTH = 1;

type CharacterState = {
  /** The Soul ID riding on every Soul generation, or none. One pick for the
      whole studio: a character is who is in the picture, not a model setting. */
  id: string | null;
  name: string | null;
  strength: number;
  pick: (character: { id: string; name: string } | null) => void;
  setStrength: (strength: number) => void;
};

export const useCharacter = create<CharacterState>()(
  persist(
    (set) => ({
      id: null,
      name: null,
      strength: DEFAULT_CHARACTER_STRENGTH,
      pick: (character) => set({ id: character?.id ?? null, name: character?.name ?? null }),
      setStrength: (strength) =>
        set({ strength: Math.min(1, Math.max(0, Math.round(strength * 100) / 100)) }),
    }),
    {
      name: "openhiggsfield.character.v1",
      storage: browserStorage(),
      partialize: (state) => ({ id: state.id, name: state.name, strength: state.strength }),
    },
  ),
);
