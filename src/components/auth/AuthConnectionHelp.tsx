import {
  memo, useEffect, useState,
} from '../../lib/teact/teact';

import useLang from '../../hooks/useLang';

type OwnProps = {
  isConnected: boolean;
};

// BCG-4: chosen, not measured. A normal connection reaches `connectionStateReady` in a few
// seconds, so this never shows for most users — it only appears when something (e.g. a browser
// content blocker) has kept the client from connecting for a while.
const CONNECTION_HELP_DELAY = 8000; // ms

const AuthConnectionHelp = ({ isConnected }: OwnProps) => {
  const lang = useLang();
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (isConnected) {
      setIsVisible(false);
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      setIsVisible(true);
    }, CONNECTION_HELP_DELAY);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [isConnected]);

  if (!isVisible) {
    return undefined;
  }

  return (
    <div className="auth-connection-help">
      <strong>{lang('AuthConnectionHelpTitle')}</strong>
      {' '}
      {lang('AuthConnectionHelpText')}
    </div>
  );
};

export default memo(AuthConnectionHelp);
