import { useEffect, useState } from "react";
import { parseRoute } from "../routing";

export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));

  useEffect(() => {
    function handleLocationChange() {
      setRoute(parseRoute(window.location.pathname));
    }

    window.addEventListener("popstate", handleLocationChange);
    window.addEventListener("storefront:navigation", handleLocationChange);

    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      window.removeEventListener("storefront:navigation", handleLocationChange);
    };
  }, []);

  function navigate(path: string) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new Event("storefront:navigation"));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return { route, navigate };
}
