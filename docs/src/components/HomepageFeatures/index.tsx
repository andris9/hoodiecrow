import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
    title: string;
    image: string;
    link: string;
    description: ReactNode;
};

const FeatureList: FeatureItem[] = [
    {
        title: 'Strict by design',
        image: '/img/features/strict.svg',
        link: '/docs/guides/strict-by-design',
        description: (
            <>
                Client input that breaks the RFCs gets <code>BAD</code> or <code>NO</code>, so client bugs show up in your tests instead of against a production
                server.
            </>
        )
    },
    {
        title: '50+ extensions',
        image: '/img/features/extensions.svg',
        link: '/docs/extensions/overview',
        description: (
            <>
                IMAP4rev1 and IMAP4rev2 with IDLE, CONDSTORE, QRESYNC, NOTIFY, ACL, METADATA, QUOTA, SORT, THREAD, COMPRESS and many more, turned on per server.
            </>
        )
    },
    {
        title: 'Control API',
        image: '/img/features/control.svg',
        link: '/docs/control-api/overview',
        description: (
            <>
                Add messages, change flags, reset UIDVALIDITY and disconnect sessions with <code>server.control</code>. Connected clients see every change.
            </>
        )
    },
    {
        title: 'Scripted faults',
        image: '/img/features/faults.svg',
        link: '/docs/faults/scripted-faults',
        description: (
            <>Script rules and quirk presets reproduce what real servers do: late responses, split output, throttling, autologout and dropped connections.</>
        )
    },
    {
        title: 'Multiple sessions',
        image: '/img/features/sessions.svg',
        link: '/docs/guides/multiple-sessions',
        description: <>Several clients on one mailbox get EXISTS, EXPUNGE and flag updates at the points the RFCs allow, following RFC 2180.</>
    },
    {
        title: 'Any language',
        image: '/img/features/rest.svg',
        link: '/docs/rest-api/overview',
        description: <>Run the imapkit command with the REST API and server events, and drive it from Python, Go or any other test suite.</>
    }
];

function Feature({ title, image, link, description }: FeatureItem) {
    return (
        <div className={clsx('col col--4', styles.feature)}>
            <Link to={link} className={styles.featureLink}>
                <img className={styles.featureImage} src={useBaseUrl(image)} alt="" />
                <Heading as="h3">{title}</Heading>
            </Link>
            <p>{description}</p>
        </div>
    );
}

export default function HomepageFeatures(): ReactNode {
    return (
        <section className={styles.features}>
            <div className="container">
                <div className="row">
                    {FeatureList.map(props => (
                        <Feature key={props.title} {...props} />
                    ))}
                </div>
            </div>
        </section>
    );
}
