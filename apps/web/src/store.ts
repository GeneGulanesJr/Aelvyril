// localStorage that never throws: private mode or a full disk only means the app forgets.
export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: the app still works, it just won't remember */
    }
  },
};
