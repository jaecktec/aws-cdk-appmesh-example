
import {useEffect} from "react";

export const useInterval = (fn: Function, timeout: number) => useEffect(() => {
  const interval = setInterval(() => {
    fn();
  }, timeout);
  return () => {
    clearInterval(interval);
  };
});
