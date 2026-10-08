import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
    const { siteConfig } = useDocusaurusContext();
    return (
        <header className={clsx('hero hero--primary', styles.heroBanner)}>
            <div className="container">
                <Heading as="h1" className="hero__title">
                    {siteConfig.title}
                </Heading>
                <p className="hero__subtitle">{siteConfig.tagline}</p>
                <div className={styles.buttons}>
                    <Link className="button button--secondary button--lg" to="/docs/getting-started/quick-start">
                        Get started
                    </Link>
                </div>
                <pre className={styles.install}>npm install --save-dev imapkit</pre>
            </div>
        </header>
    );
}

export default function Home(): ReactNode {
    return (
        <Layout
            title="In-memory IMAP server for testing IMAP clients"
            description="ImapKit is a scriptable, in-memory IMAP4rev1 and IMAP4rev2 server with 50+ extensions for testing IMAP clients."
        >
            <HomepageHeader />
            <main>
                <HomepageFeatures />
            </main>
        </Layout>
    );
}
