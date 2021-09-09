import React, { useEffect, useState } from 'react';
import './color.css';
import { useInterval } from '../../helper/use-intervall';
import axios from 'axios';

type ColorResponse = {
  color: string
}
type VersionResponse = {
  version: string
}

export const Color: React.FC = () => {
  const [ updateTrigger, setUpdateTrigger ] = useState<number>(0);
  const [ color, setColor ] = useState<ColorResponse | undefined>();
  const [ version, setVersion ] = useState<VersionResponse | undefined>();
  useInterval(() => {
    setUpdateTrigger((old) => old + 1);
  }, 5000);


  useEffect(() => {
    (async () => {
      await axios.all([
          axios.get<ColorResponse>('gateway/color/color').then(({ data }) => setColor(data)),
          axios.get<VersionResponse>('gateway/version').then(({ data }) => setVersion(data)),
        ],
      )
      ;
    })();
  }, [ updateTrigger ]);

  return <a className="colorBanner" style={{ backgroundColor: color?.color }}>
    <p className="issueBanner__state">{version?.version}</p>
    <h2>{color?.color}</h2>
  </a>;
};
