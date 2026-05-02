/**
 * VaultLink Mini App — 404.
 *
 * Reached when the user lands on a route the router doesn't know about
 * (typing in the URL, stale deep-link, etc). Single CTA back to home.
 */

import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout.js';
import { EmptyState } from '../components/EmptyState.js';
import { Button } from '../components/Button.js';
import { useT } from '../lib/i18n.js';

export function NotFound(): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  return (
    <Layout title="404" back={() => navigate('/', { replace: true })} hideNav>
      <EmptyState
        title="404"
        description="The page you're looking for doesn't exist."
        cta={
          <Button onClick={() => navigate('/', { replace: true })}>{t('common.back')}</Button>
        }
      />
    </Layout>
  );
}
