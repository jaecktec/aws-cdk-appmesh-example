import React from 'react';
import './App.css';
import { SiteHeader } from './components/site-header/site-header';
import { Color } from './components/color/color';

function App() {
  return (
    <div className="App">
      <SiteHeader/>
      <div className="container">

        <section className="ongoingIssues">
          <Color/>
        </section>

      </div>
    </div>
  );
}

export default App;
