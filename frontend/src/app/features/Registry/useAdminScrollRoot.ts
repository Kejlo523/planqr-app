import { useEffect } from "react";

const scrollClass = "admin-console-scroll-root";

export function useAdminScrollRoot() {
  useEffect(() => {
    document.documentElement.classList.add(scrollClass);
    document.body.classList.add(scrollClass);

    return () => {
      document.documentElement.classList.remove(scrollClass);
      document.body.classList.remove(scrollClass);
    };
  }, []);
}
