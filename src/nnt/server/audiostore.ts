import {Rest} from "./rest";
import {Node} from "../config/config";
import {pathd} from "../core/url";
import fs = require("fs");
import {RAudioStore} from "./raudiostore";
import {IMediaStore} from "./imediastore";

interface AudioStoreNode extends Node {
    // 存储位置
    store: string;
}

export class AudioStore extends Rest implements IMediaStore {

    constructor() {
        super();
        this.routers.register(new RAudioStore());
    }

    @pathd()
    store: string;
    unsafe: boolean;

    config(cfg: Node): boolean {
        if (!super.config(cfg))
            return false;
        let c = <AudioStoreNode>cfg;
        if (!c.store)
            return false;
        this.store = c.store;
        return true;
    }

    async start(): Promise<void> {
        await super.start();
        if (!fs.existsSync(this.store))
            fs.mkdirSync(this.store);
    }
}
