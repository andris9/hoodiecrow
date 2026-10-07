/** An address, or a group with its member addresses */
export interface ParsedAddress {
    name: string;
    address?: string;
    group?: ParsedAddress[];
}

interface Token {
    type: 'operator' | 'text';
    value: string;
}

/**
 * Parses structured e-mail addresses from an address field
 *
 * Example:
 *
 *    "Name <address@domain>"
 *
 * will be converted to
 *
 *     [{name: "Name", address: "address@domain"}]
 *
 * @param {String} str Address field
 * @return {Array} An array of address objects
 */
export default function parse(str: string, inGroup?: boolean): ParsedAddress[] {
    const tokenizer = new Tokenizer(str);
    const tokens = tokenizer.tokenize();

    const addresses: Token[][] = [];
    let address: Token[] = [];
    let parsedAddresses: ParsedAddress[] = [];

    tokens.forEach(token => {
        if (token.type === 'operator' && (token.value === ',' || token.value === ';')) {
            if (address.length) {
                addresses.push(address);
            }
            address = [];
        } else {
            address.push(token);
        }
    });

    if (address.length) {
        addresses.push(address);
    }

    addresses.forEach(address => {
        const handled = _handleAddress(address, inGroup);
        if (handled.length) {
            parsedAddresses = parsedAddresses.concat(handled);
        }
    });

    return parsedAddresses;
}

/**
 * Converts tokens for a single address into an address object
 *
 * @param {Array} tokens Tokens object
 * @param {Boolean} [inGroup] If true, the tokens are a member of a group. Groups do not nest
 *        (RFC 5322 3.4), so a colon is not a group separator here
 * @return {Object} Address object
 */
function _handleAddress(tokens: Token[], inGroup?: boolean): ParsedAddress[] {
    let token: Token;
    let isGroup = false;
    let state: 'address' | 'comment' | 'group' | 'text' = 'text';
    let address: ParsedAddress | undefined;
    const addresses: ParsedAddress[] = [];
    const data: { address: string[]; comment: string[]; group: string[]; text: string[] } = {
        address: [],
        comment: [],
        group: [],
        text: []
    };
    let i: number;
    let len: number;

    // Filter out <addresses>, (comments) and regular text
    for (i = 0, len = tokens.length; i < len; i++) {
        token = tokens[i];

        if (token.type === 'operator') {
            switch (token.value) {
                case '<':
                    state = 'address';
                    break;
                case '(':
                    state = 'comment';
                    break;
                case ':':
                    if (inGroup) {
                        state = 'text';
                        break;
                    }
                    state = 'group';
                    isGroup = true;
                    break;
                default:
                    state = 'text';
            }
        } else {
            if (token.value) {
                data[state].push(token.value);
            }
        }
    }

    // If there is no text but a comment, replace the two
    if (!data.text.length && data.comment.length) {
        data.text = data.comment;
        data.comment = [];
    }

    if (isGroup) {
        // http://tools.ietf.org/html/rfc2822#appendix-A.1.3
        const text = data.text.join(' ');
        addresses.push({
            // address is never set here, so an empty group name throws like the JavaScript original did
            name: text || address!.name,
            group: data.group.length ? parse(data.group.join(','), true) : []
        });
    } else {
        // If no address was found, try to detect one from regular text
        if (!data.address.length && data.text.length) {
            for (i = data.text.length - 1; i >= 0; i--) {
                if (data.text[i].match(/^[^@\s]+@[^@\s]+$/)) {
                    data.address = data.text.splice(i, 1);
                    break;
                }
            }

            const _regexHandler = function (address: string): string {
                if (!data.address.length) {
                    data.address = [address.trim()];
                    return ' ';
                } else {
                    return address;
                }
            };

            // still no address
            if (!data.address.length) {
                for (i = data.text.length - 1; i >= 0; i--) {
                    data.text[i] = data.text[i].replace(/\s*\b[^@\s]+@[^@\s]+\b\s*/, _regexHandler).trim();
                    if (data.address.length) {
                        break;
                    }
                }
            }
        }

        // If there's still is no text but a comment exixts, replace the two
        if (!data.text.length && data.comment.length) {
            data.text = data.comment;
            data.comment = [];
        }

        // Keep only the first address occurence, push others to regular text
        if (data.address.length > 1) {
            data.text = data.text.concat(data.address.splice(1));
        }

        // Join values with spaces
        const text = data.text.join(' ');
        const addressText = data.address.join(' ');

        if (!addressText && isGroup) {
            return [];
        } else {
            address = {
                address: addressText || text || '',
                name: text || addressText || ''
            };

            if (address.address === address.name) {
                if ((address.address || '').match(/@/)) {
                    address.name = '';
                } else {
                    address.address = '';
                }
            }

            addresses.push(address);
        }
    }

    return addresses;
}

/**
 * Creates a Tokenizer object for tokenizing address field strings
 *
 * @constructor
 * @param {String} str Address field string
 */
class Tokenizer {
    declare str: string;
    declare operatorCurrent: string;
    declare operatorExpecting: string;
    declare node: Token | null;
    declare escaped: boolean;
    declare list: Token[];
    /** operator tokens and the tokens that end their sequence, on the prototype */
    declare operators: Record<string, string>;

    constructor(str: string) {
        this.str = (str || '').toString();
        this.operatorCurrent = '';
        this.operatorExpecting = '';
        this.node = null;
        this.escaped = false;

        this.list = [];
    }

    /**
     * Tokenizes the original input string
     *
     * @return {Array} An array of operator|text tokens
     */
    tokenize(): Token[] {
        let chr: string;
        const list: Token[] = [];
        for (let i = 0, len = this.str.length; i < len; i++) {
            chr = this.str.charAt(i);
            this.checkChar(chr);
        }

        this.list.forEach(node => {
            node.value = (node.value || '').toString().trim();
            if (node.value) {
                list.push(node);
            }
        });

        return list;
    }

    /**
     * Checks if a character is an operator or text and acts accordingly
     *
     * @param {String} chr Character from the address field
     */
    checkChar(chr: string): void {
        if ((chr in this.operators || chr === '\\') && this.escaped) {
            this.escaped = false;
        } else if (this.operatorExpecting && chr === this.operatorExpecting) {
            this.node = {
                type: 'operator',
                value: chr
            };
            this.list.push(this.node);
            this.node = null;
            this.operatorExpecting = '';
            this.escaped = false;
            return;
        } else if (!this.operatorExpecting && chr in this.operators) {
            this.node = {
                type: 'operator',
                value: chr
            };
            this.list.push(this.node);
            this.node = null;
            this.operatorExpecting = this.operators[chr];
            this.escaped = false;
            return;
        }

        if (!this.escaped && chr === '\\') {
            this.escaped = true;
            return;
        }

        if (!this.node) {
            this.node = {
                type: 'text',
                value: ''
            };
            this.list.push(this.node);
        }

        if (this.escaped && chr !== '\\') {
            this.node.value += '\\';
        }

        this.node.value += chr;
        this.escaped = false;
    }
}

/**
 * Operator tokens and which tokens are expected to end the sequence
 */
Tokenizer.prototype.operators = {
    '"': '"',
    '(': ')',
    '<': '>',
    ',': '',
    ':': ';'
};
