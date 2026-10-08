import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
    docsSidebar: [
        'intro',
        {
            type: 'category',
            label: 'Getting Started',
            collapsed: false,
            items: ['getting-started/installation', 'getting-started/quick-start']
        }
    ]
};

export default sidebars;
