import * as React from 'react';

import { PocketTerminalModuleViewProps } from './PocketTerminalModule.types';

export default function PocketTerminalModuleView(props: PocketTerminalModuleViewProps) {
  return (
    <div>
      <iframe
        style={{ flex: 1 }}
        src={props.url}
        onLoad={() => props.onLoad({ nativeEvent: { url: props.url } })}
      />
    </div>
  );
}
