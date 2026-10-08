import type { ReactNode } from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
    title: string;
    description: ReactNode;
};

const FeatureList: FeatureItem[] = [
    {
        title: 'Strict by design',
        description: (
            <>
                IMAP4rev1 and IMAP4rev2 with more than 50 extensions. Client input that breaks the RFCs gets <code>BAD</code> or <code>NO</code>, so client bugs
                show up in your tests, not in production.
            </>
        )
    },
    {
        title: 'Controlled from your tests',
        description: (
            <>
                Add messages, change flags, reset UIDVALIDITY and disconnect sessions with <code>server.control</code>, or over the optional REST API from any
                language.
            </>
        )
    },
    {
        title: 'Misbehaves on purpose',
        description: <>Script rules and quirk presets reproduce the bugs of real servers: late responses, split output, throttling and dropped connections.</>
    }
];

function Feature({ title, description }: FeatureItem) {
    return (
        <div className={clsx('col col--4')}>
            <div className="text--center padding-horiz--md">
                <Heading as="h3">{title}</Heading>
                <p>{description}</p>
            </div>
        </div>
    );
}

export default function HomepageFeatures(): ReactNode {
    return (
        <section className={styles.features}>
            <div className="container">
                <div className="row">
                    {FeatureList.map((props, idx) => (
                        <Feature key={idx} {...props} />
                    ))}
                </div>
            </div>
        </section>
    );
}
